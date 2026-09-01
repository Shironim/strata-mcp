import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { findComponentInTemplateBlock, getCandidateNames } from './template';
import { remapMatches } from './remapper';
import type { RawMatch, ResolvedMatch } from '../types';
import { collectFiles } from './collector';
import { formatMatchesAsText } from './formatter';
import { runConcurrent } from './pool';
import { createDocumentAdapter } from '../adapters/factory';

// Re-export utility functions
export { collectFiles, formatMatchesAsText };

export interface SearchOptions {
  pattern?: string;
  rule?: string;
  targetPath: string;
  language?: string;
  maxResults?: number;
  concurrency?: number;
}

export interface ComponentSearchOptions {
  componentName: string;
  targetPath: string;
  scope?: 'template' | 'script' | 'both';
  maxResults?: number;
  concurrency?: number;
}

/**
 * Extracts non-metavariable literal keywords from an ast-grep pattern to enable fast-path pruning.
 */
export function extractPatternKeywords(pattern?: string): string[] {
  if (!pattern) return [];

  const words = pattern
    .replace(/\$[A-Za-z0-9_]+/g, ' ')
    .replace(/\$\$\$[A-Za-z0-9_]*/g, ' ')
    .split(/[^A-Za-z0-9_]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !w.startsWith('$'));

  return Array.from(new Set(words));
}

/**
 * Extracts literal keywords from an ast-grep YAML rule to enable fast-path pruning.
 */
export function extractRuleKeywords(ruleYaml?: string): string[] {
  if (!ruleYaml) return [];
  const patternMatches = ruleYaml.match(/pattern:\s*['"]?([^'"\r\n]+)['"]?/g);
  if (!patternMatches) return [];

  const allKeywords = new Set<string>();
  for (const pMatch of patternMatches) {
    const rawPattern = pMatch.replace(/pattern:\s*['"]?/, '').replace(/['"]$/, '');
    const kw = extractPatternKeywords(rawPattern);
    for (const w of kw) allKeywords.add(w);
  }
  return Array.from(allKeywords);
}

/**
 * Scans script code for imports, dynamic imports, barrel re-exports, and extracts local alias if any.
 */
async function findScriptUsages(
  code: string,
  componentName: string,
  lang: string
): Promise<{ matches: RawMatch[]; localAliases: string[]; localAlias?: string }> {
  const matches: RawMatch[] = [];
  const localAliases: string[] = [];
  const candidates = getCandidateNames(componentName);

  // 1. Static imports: `import $$$ from '$$$'`
  try {
    const staticImports = await executeAstGrep({
      code,
      pattern: `import $$$ from '$$$'`,
      language: lang,
    });

    for (const m of staticImports) {
      if (candidates.some((cand) => m.text.includes(cand))) {
        matches.push(m);

        // Check for alias: `import { X as Y }`
        for (const cand of candidates) {
          const aliasMatch = m.text.match(new RegExp(`\\b${cand}\\s+as\\s+([A-Za-z0-9_$]+)`));
          if (aliasMatch && aliasMatch[1]) {
            if (!localAliases.includes(aliasMatch[1])) {
              localAliases.push(aliasMatch[1]);
            }
          }
        }
      }
    }
  } catch (err) {
    if (isBinaryExecutionError(err)) throw err;
    // Non-fatal fallback
  }

  // 2. Barrel re-exports: rule using kind: export_statement
  const exportRule = `
id: all-exports
message: match export
language: ${lang === 'js' ? 'js' : 'ts'}
rule:
  kind: export_statement
`;

  try {
    const reExports = await executeAstGrep({
      code,
      rule: exportRule,
      language: lang,
    });

    for (const m of reExports) {
      if (
        candidates.some((cand) => m.text.includes(cand)) &&
        (m.text.includes('export {') || m.text.includes('export *') || m.text.includes('export default'))
      ) {
        if (!matches.some((existing) => existing.line === m.line && existing.column === m.column)) {
          matches.push(m);
        }
      }
    }
  } catch (err) {
    if (isBinaryExecutionError(err)) throw err;
    // Non-fatal fallback
  }

  // 3. Dynamic / Lazy Imports: line-based detection for defineAsyncComponent, React.lazy, dynamic(), import()
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const matchedCandidate = candidates.find((cand) => lineText.includes(cand));
    if (
      matchedCandidate &&
      (lineText.includes('import(') ||
        lineText.includes('defineAsyncComponent') ||
        lineText.includes('lazy(') ||
        lineText.includes('dynamic('))
    ) {
      const lineNum = i + 1;
      if (!matches.some((existing) => existing.line === lineNum)) {
        matches.push({
          line: lineNum,
          column: Math.max(1, lineText.indexOf(matchedCandidate) + 1),
          text: lineText.trim(),
        });
      }
    }
  }

  return { matches, localAliases, localAlias: localAliases[0] };
}

/**
 * Searches code by simple pattern across all supported files concurrently using DocumentAdapters.
 */
export async function findCode(options: SearchOptions): Promise<ResolvedMatch[]> {
  const files = await collectFiles(resolve(options.targetPath));
  const limit = options.maxResults || 200;
  const keywords = extractPatternKeywords(options.pattern);

  const fileResults = await runConcurrent(
    files,
    async (file) => {
      const content = await fs.readFile(file, 'utf8');

      // Fast-Path Candidate Pruning (Engine B): skip file if required literal keywords are missing
      if (keywords.length > 0 && !keywords.every((kw) => content.includes(kw))) {
        return [];
      }

      const adapter = createDocumentAdapter(file, content);
      const matches: ResolvedMatch[] = [];

      for (const block of adapter.getScriptBlocks()) {
        const rawMatches = await executeAstGrep({
          code: block.content,
          pattern: options.pattern,
          language: options.language || block.lang || 'ts',
        });
        matches.push(...remapMatches(rawMatches, block, file));
      }

      // Scan template block for HTML / component tag patterns in .vue and .astro
      const templateBlock = adapter.getTemplateBlock();
      if (templateBlock) {
        const isTagPattern =
          options.language === 'html' ||
          /^\s*<[A-Za-z0-9_$-]/.test(options.pattern || '') ||
          Boolean(options.pattern?.includes('</') || options.pattern?.endsWith('/>'));

        if (isTagPattern) {
          try {
            const rawMatches = await executeAstGrep({
              code: templateBlock.content,
              pattern: options.pattern,
              language: 'html',
            });
            matches.push(...remapMatches(rawMatches, templateBlock, file));
          } catch (err) {
            if (isBinaryExecutionError(err)) throw err;
            // Non-fatal fallback for template matching
          }
        }
      }

      return matches;
    },
    options.concurrency
  );

  const allMatches = fileResults.flat();
  return allMatches.slice(0, limit);
}

/**
 * Searches code by complex YAML rule across all supported files concurrently using DocumentAdapters.
 */
export async function findCodeByRule(options: SearchOptions): Promise<ResolvedMatch[]> {
  if (!options.rule) {
    throw new Error('Rule YAML is required for findCodeByRule');
  }

  const files = await collectFiles(resolve(options.targetPath));
  const limit = options.maxResults || 200;
  const keywords = extractRuleKeywords(options.rule);

  const fileResults = await runConcurrent(
    files,
    async (file) => {
      const content = await fs.readFile(file, 'utf8');

      // Fast-Path Candidate Pruning (Engine B): skip file if candidate keywords are absent
      if (keywords.length > 0 && !keywords.some((kw) => content.includes(kw))) {
        return [];
      }

      const adapter = createDocumentAdapter(file, content);
      const matches: ResolvedMatch[] = [];

      for (const block of adapter.getScriptBlocks()) {
        const rawMatches = await executeAstGrep({
          code: block.content,
          rule: options.rule,
          language: options.language || block.lang || 'ts',
        });
        matches.push(...remapMatches(rawMatches, block, file));
      }

      // Scan template block if rule targets HTML or language is html
      const templateBlock = adapter.getTemplateBlock();
      if (templateBlock && (options.language === 'html' || options.rule?.includes('language: html'))) {
        try {
          const rawMatches = await executeAstGrep({
            code: templateBlock.content,
            rule: options.rule,
            language: 'html',
          });
          matches.push(...remapMatches(rawMatches, templateBlock, file));
        } catch (err) {
          if (isBinaryExecutionError(err)) throw err;
          // Non-fatal fallback
        }
      }

      return matches;
    },
    options.concurrency
  );

  const allMatches = fileResults.flat();
  return allMatches.slice(0, limit);
}

/**
 * Searches component usage across templates (Vue/Astro/JSX) and scripts (imports/lazy/re-exports) concurrently.
 */
export async function findComponentUsage(options: ComponentSearchOptions): Promise<ResolvedMatch[]> {
  const files = await collectFiles(resolve(options.targetPath));
  const scope = options.scope || 'both';
  const limit = options.maxResults || 200;
  const candidates = getCandidateNames(options.componentName);

  const fileResults = await runConcurrent(
    files,
    async (file) => {
      const content = await fs.readFile(file, 'utf8');

      // Fast-Path Candidate Pruning (Engine B): skip file if none of the component name candidates appear
      if (!candidates.some((cand) => content.includes(cand))) {
        return [];
      }

      const adapter = createDocumentAdapter(file, content);
      const matches: ResolvedMatch[] = [];
      const detectedAliases = new Set<string>();

      // 1. Script Scope & Metadata Extraction
      // Scan script blocks: always extract aliases for template / JSX usage,
      // but only push script matches to results if scope is 'script' or 'both'.
      for (const block of adapter.getScriptBlocks()) {
        const { matches: scriptMatches, localAliases, localAlias } = await findScriptUsages(
          block.content,
          options.componentName,
          block.lang || 'ts'
        );
        if (localAliases) {
          for (const alias of localAliases) {
            detectedAliases.add(alias);
          }
        } else if (localAlias) {
          detectedAliases.add(localAlias);
        }

        if (scope === 'script' || scope === 'both') {
          matches.push(...remapMatches(scriptMatches, block, file));
        }
      }

      // 2. Template Scope (Vue template, Astro template, or JSX element)
      if (scope === 'template' || scope === 'both') {
        const templateBlock = adapter.getTemplateBlock();

        if (templateBlock) {
          // Vue or Astro template
          const tMatches = findComponentInTemplateBlock(templateBlock, options.componentName, file);
          matches.push(...tMatches);

          for (const alias of detectedAliases) {
            const aliasMatches = findComponentInTemplateBlock(templateBlock, alias, file);
            for (const am of aliasMatches) {
              if (!matches.some((e) => e.file === am.file && e.line === am.line && e.column === am.column)) {
                matches.push(am);
              }
            }
          }
        } else if (adapter.isJsx()) {
          // React / JSX elements
          const candidateNames = getCandidateNames(options.componentName);
          const targetNames = [...candidateNames];
          for (const alias of detectedAliases) {
            targetNames.push(...getCandidateNames(alias));
          }

          const jsxRule = `
id: all-jsx-elements
message: jsx
language: tsx
rule:
  any:
    - kind: jsx_opening_element
    - kind: jsx_self_closing_element
`;

          try {
            const jsxMatches = await executeAstGrep({
              code: content,
              rule: jsxRule,
              language: 'tsx',
            });

            for (const m of jsxMatches) {
              const isMatch = targetNames.some((name) => {
                const tagRegex = new RegExp(`^<([A-Za-z0-9_$.]+\\.)?${name}[\\s/>]`);
                return tagRegex.test(m.text);
              });

              if (isMatch) {
                if (!matches.some((e) => e.file === file && e.line === m.line && e.column === m.column)) {
                  matches.push({
                    file,
                    line: m.line,
                    column: m.column,
                    endLine: m.endLine,
                    endColumn: m.endColumn,
                    snippet: m.text.split('\n')[0] || m.text,
                  });
                }
              }
            }
          } catch (err) {
            if (isBinaryExecutionError(err)) throw err;
            // Non-fatal fallback
          }
        }
      }

      return matches;
    },
    options.concurrency
  );

  const allMatches = fileResults.flat();
  return allMatches.slice(0, limit);
}
