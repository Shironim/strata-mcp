import { readSourceFile } from './source-file';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import {
  extractTemplateExpressions,
  findComponentInTemplateBlock,
  getCandidateNames,
} from './template';
import { remapMatches } from './remapper';
import { queryTemplateExpressions } from './expression-batch';
import { escapeRegExp, JS_IDENTIFIER } from './patterns';
import type { RawMatch, ResolvedMatch } from '../types';
import { collectFiles } from './collector';
import { formatMatchesAsText } from './formatter';
import { collectConcurrentMatches } from './pool';
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
  excludeDirs?: string[];
}

/** Exact, case-sensitive substrings; regex syntax and escapes have no special meaning. */
export function matchLiteralLines(content: string, pattern: string): RawMatch[] {
  if (!pattern || /[\r\n]/.test(pattern)) throw new Error('Literal pattern must be a non-empty single line');
  return content.split(/\r?\n/).flatMap((text, index) => {
    const column = text.indexOf(pattern);
    return column < 0 ? [] : [{ line: index + 1, column: column + 1, text }];
  });
}

export async function findLiteralCode(options: SearchOptions): Promise<ResolvedMatch[]> {
  const files = await collectFiles(resolve(options.targetPath), { excludeDirs: options.excludeDirs });
  const matches: ResolvedMatch[] = [];
  const limit = options.maxResults || 200;
  // Validate even when no files are found.
  matchLiteralLines('', options.pattern || '');
  for (const file of files) {
    const content = await readSourceFile(file);
    for (const match of matchLiteralLines(content, options.pattern!)) {
      matches.push({ file, line: match.line, column: match.column, snippet: match.text });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export interface ComponentSearchOptions {
  componentName: string;
  targetPath: string;
  scope?: 'template' | 'script' | 'both';
  maxResults?: number;
  concurrency?: number;
  excludeDirs?: string[];
}

/**
 * Extracts non-metavariable literal keywords from an ast-grep pattern to enable fast-path pruning.
 */
export function extractPatternKeywords(pattern?: string): string[] {
  if (!pattern) return [];

  const words = pattern
    .replace(/\${1,3}[A-Za-z0-9_]*/g, ' ')
    .split(/[^A-Za-z0-9_]+/)
    .filter((w) => w.length >= 2);

  return Array.from(new Set(words));
}

/**
 * Extracts literal keywords from an ast-grep YAML rule to enable fast-path pruning.
 * Only extracts keywords from unambiguous positive rules; if negative (not),
 * disjunctive (any), relational (inside, has, follows, precedes), or complex
 * matchers are present, pruning is skipped to guarantee disk/snippet parity.
 */
export function extractRuleKeywords(ruleYaml?: string): string[] {
  if (!ruleYaml) return [];
  // Prune only a single plain pattern. YAML composition cannot prove mandatory keywords.
  const rule = ruleYaml.match(/^rule:[ \t]*\r?\n([\s\S]*)/m)?.[1];
  const value = rule?.match(/^[ \t]+pattern:[ \t]*([^\r\n]+)\s*$/)?.[1].trim();
  if (!value || /^[{|>&*!]/.test(value)) return [];
  return extractPatternKeywords(value.replace(/^(['"])([\s\S]*)\1$/, '$2'));

}

/**
 * Extracts the local alias from an import clause, e.g. `import { X as Y }` -> `Y`.
 */
function extractImportAlias(importText: string, componentName: string): string | undefined {
  const pattern = new RegExp(`\\b${escapeRegExp(componentName)}\\s+as\\s+(${JS_IDENTIFIER})`);
  return importText.match(pattern)?.[1];
}

/**
 * Checks whether a JSX element opening tag refers to the given component name.
 * Supports namespace syntax such as `<UI.OldButton />`.
 */
function isJsxElementNameMatch(text: string, componentName: string): boolean {
  const pattern = new RegExp(`^<([A-Za-z0-9_$.]+\\.)?${escapeRegExp(componentName)}[\\s/>]`);
  return pattern.test(text);
}

/**
 * Scans script code for imports, dynamic imports, barrel re-exports, and extracts local alias if any.
 */
async function findScriptUsages(
  code: string,
  componentName: string,
  lang: string
): Promise<{ matches: RawMatch[]; localAliases: string[] }> {
  const matches: RawMatch[] = [];
  const localAliases: string[] = [];
  const candidates = getCandidateNames(componentName);

  // 1. Static imports: rule using kind: import_statement (matches single & double quotes)
  const importRule = `
id: all-imports
message: match import
language: ${lang === 'js' ? 'js' : 'ts'}
rule:
  kind: import_statement
`;
  try {
    const staticImports = await executeAstGrep({
      code,
      rule: importRule,
      language: lang,
    });

    for (const m of staticImports) {
      if (candidates.some((cand) => m.text.includes(cand))) {
        matches.push(m);

        // Check for alias: `import { X as Y }`
        for (const cand of candidates) {
          const alias = extractImportAlias(m.text, cand);
          if (alias && !localAliases.includes(alias)) {
            localAliases.push(alias);
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

  return { matches, localAliases };
}

/**
 * Searches code by simple pattern across all supported files concurrently using DocumentAdapters.
 */
export async function findCode(options: SearchOptions): Promise<ResolvedMatch[]> {
  const files = (await collectFiles(resolve(options.targetPath), {
    excludeDirs: options.excludeDirs,
  })).sort();
  const limit = options.maxResults || 200;
  const keywords = extractPatternKeywords(options.pattern);

  const matches = await collectConcurrentMatches(
    files,
    async (file) => {
      const content = await readSourceFile(file);

      // Fast-Path Candidate Pruning (Engine B): skip file if required literal keywords are missing
      if (keywords.length > 0) {
        const hasAlternation = Boolean(options.pattern && (options.pattern.includes('||') || options.pattern.includes('|')));
        const satisfiesKeywords = hasAlternation
          ? keywords.some((kw) => content.includes(kw))
          : keywords.every((kw) => content.includes(kw));
        if (!satisfiesKeywords) {
          return [];
        }
      }

      const adapter = createDocumentAdapter(file, content);
      const matches: ResolvedMatch[] = [];

      const effectiveScriptLang =
        options.language && options.language !== 'vue' && options.language !== 'astro' && options.language !== 'auto'
          ? options.language
          : undefined;

      for (const block of adapter.getSearchScriptBlocks?.() ?? adapter.getScriptBlocks()) {
        if (matches.length >= limit) return matches;
        try {
          const rawMatches = await executeAstGrep({
            code: block.content,
            pattern: options.pattern,
            language: effectiveScriptLang || block.lang || 'ts',
            maxResults: limit - matches.length,
          });
          matches.push(...remapMatches(rawMatches, block, file));
        } catch (err) {
          if (isBinaryExecutionError(err)) throw err;
          // Non-fatal fallback: pattern might be for another language/block (e.g. template tag vs script)
        }
      }

      // Scan template block for HTML / component tag patterns in .vue and .astro
      if (matches.length >= limit) return matches;
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
              maxResults: limit - matches.length,
            });
            matches.push(...remapMatches(rawMatches, templateBlock, file));
          } catch (err) {
            if (isBinaryExecutionError(err)) throw err;
            // Non-fatal fallback for template matching
          }
        } else if (options.language !== 'html') {
          // Scan JS expressions inside template directives and interpolations (batched).
          const expressions = adapter.getSearchExpressions?.() ?? extractTemplateExpressions(templateBlock.content);
          matches.push(
            ...(await queryTemplateExpressions({
              expressions,
              templateBlock,
              filePath: file,
              pattern: options.pattern,
              language: effectiveScriptLang || (adapter.type === 'astro' ? 'tsx' : 'ts'),
              maxResults: limit - matches.length,
            }))
          );
        }
      }

      return matches;
    },
    limit, options.concurrency
  );

  return matches;
}

/**
 * Searches code by complex YAML rule across all supported files concurrently using DocumentAdapters.
 */
export async function findCodeByRule(options: SearchOptions): Promise<ResolvedMatch[]> {
  if (!options.rule) {
    throw new Error('Rule YAML is required for findCodeByRule');
  }

  const files = (await collectFiles(resolve(options.targetPath), {
    excludeDirs: options.excludeDirs,
  })).sort();
  const limit = options.maxResults || 200;
  const keywords = extractRuleKeywords(options.rule);

  const matches = await collectConcurrentMatches(
    files,
    async (file) => {
      const content = await readSourceFile(file);

      // Fast-Path Candidate Pruning (Engine B): skip file if candidate keywords are absent
      if (keywords.length > 0 && !keywords.some((kw) => content.includes(kw))) {
        return [];
      }

      const adapter = createDocumentAdapter(file, content);
      const matches: ResolvedMatch[] = [];

      const effectiveScriptLang =
        options.language && options.language !== 'vue' && options.language !== 'astro' && options.language !== 'auto'
          ? options.language
          : undefined;

      for (const block of adapter.getSearchScriptBlocks?.() ?? adapter.getScriptBlocks()) {
        if (matches.length >= limit) return matches;
        const rawMatches = await executeAstGrep({
          code: block.content,
          rule: options.rule,
          language: effectiveScriptLang || block.lang || 'ts',
          maxResults: limit - matches.length,
        });
        matches.push(...remapMatches(rawMatches, block, file));
      }

      // Scan template block if rule targets HTML; otherwise scan JS expressions in the template.
      if (matches.length >= limit) return matches;
      const templateBlock = adapter.getTemplateBlock();
      if (templateBlock) {
        const ruleTargetsHtml =
          options.language === 'html' || options.rule?.includes('language: html');

        if (ruleTargetsHtml) {
          try {
            const rawMatches = await executeAstGrep({
              code: templateBlock.content,
              rule: options.rule,
              language: 'html',
              maxResults: limit - matches.length,
            });
            matches.push(...remapMatches(rawMatches, templateBlock, file));
          } catch (err) {
            if (isBinaryExecutionError(err)) throw err;
            // Non-fatal fallback
          }
        } else {
          const expressions = adapter.getSearchExpressions?.() ?? extractTemplateExpressions(templateBlock.content);
          matches.push(
            ...(await queryTemplateExpressions({
              expressions,
              templateBlock,
              filePath: file,
              rule: options.rule,
              maxResults: limit - matches.length,
            }))
          );
        }
      }

      return matches;
    },
    limit, options.concurrency
  );

  return matches;
}

/**
 * Searches component usage across templates (Vue/Astro/JSX) and scripts (imports/lazy/re-exports) concurrently.
 */
export async function findComponentUsage(options: ComponentSearchOptions): Promise<ResolvedMatch[]> {
  const files = (await collectFiles(resolve(options.targetPath), {
    excludeDirs: options.excludeDirs,
  })).sort();
  const scope = options.scope || 'both';
  const limit = options.maxResults || 200;
  const candidates = getCandidateNames(options.componentName);

  const matches = await collectConcurrentMatches(
    files,
    async (file) => {
      const content = await readSourceFile(file);

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
        const { matches: scriptMatches, localAliases } = await findScriptUsages(
          block.content,
          options.componentName,
          block.lang || 'ts'
        );
        for (const alias of localAliases) {
          detectedAliases.add(alias);
        }

        if (scope === 'script' || scope === 'both') {
          const remapped = remapMatches(scriptMatches, block, file);
          for (const m of remapped) m.usageKind = /^\s*export\b/.test(m.snippet) ? 'export' : 'import';
          matches.push(...remapped);
        }
      }

      // 2. Template Scope (Vue template, Astro template, or JSX element)
      if (scope === 'template' || scope === 'both') {
        const templateBlock = adapter.getTemplateBlock();

        if (templateBlock) {
          // Vue or Astro template
          const tMatches = findComponentInTemplateBlock(templateBlock, options.componentName, file);
          for (const m of tMatches) m.usageKind = 'render';
          matches.push(...tMatches);

          for (const alias of detectedAliases) {
            const aliasMatches = findComponentInTemplateBlock(templateBlock, alias, file);
            for (const am of aliasMatches) {
              am.usageKind = 'render';
              if (!matches.some((e) => e.file === am.file && e.line === am.line && e.column === am.column)) {
                matches.push(am);
              }
            }
          }
        } else if (adapter.isJsx()) {
          // React / JSX elements (PascalCase/namespaced only; exclude intrinsic lowercase HTML tags)
          const candidateNames = getCandidateNames(options.componentName);
          const targetNames = [...candidateNames, ...Array.from(detectedAliases).flatMap((a) => getCandidateNames(a))]
            .filter((name) => /^[A-Z]/.test(name));

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
              const isMatch = targetNames.some((name) => isJsxElementNameMatch(m.text, name));

              if (isMatch) {
                if (!matches.some((e) => e.file === file && e.line === m.line && e.column === m.column)) {
                  matches.push({
                    file,
                    line: m.line,
                    column: m.column,
                    endLine: m.endLine,
                    endColumn: m.endColumn,
                    usageKind: 'render',
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
    limit, options.concurrency
  );

  return matches;
}
