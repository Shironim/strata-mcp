import { readSourceFile } from './source-file';
import { promises as fs } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { executeAstGrep } from './astgrep';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { getWorkspaceDatabase } from './database';
import { findProjectRoot } from './path-resolver';
import { escapeRegExp } from './patterns';
import type { RawMatch, SliceSymbolOptions, SymbolKind, SymbolSliceResult } from '../types';

/**
 * Builds an ast-grep rule YAML to locate the declaration of a specific symbol.
 */
export function buildSymbolRuleYaml(symbolName: string, lang: string = 'ts'): string {
  const safeLang = lang === 'jsx' || lang === 'tsx' ? 'tsx' : 'ts';
  const escapedName = escapeRegExp(symbolName);

  return `id: find-symbol-${Date.now()}
language: ${safeLang}
rule:
  any:
    - kind: export_statement
      has:
        any:
          - kind: function_declaration
            has:
              field: name
              regex: "^${escapedName}$"
          - kind: lexical_declaration
            has:
              kind: variable_declarator
              has:
                field: name
                regex: "^${escapedName}$"
          - kind: class_declaration
            has:
              field: name
              regex: "^${escapedName}$"
          - kind: interface_declaration
            has:
              field: name
              regex: "^${escapedName}$"
          - kind: type_alias_declaration
            has:
              field: name
              regex: "^${escapedName}$"
    - kind: function_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: "^${escapedName}$"
    - kind: lexical_declaration
      not:
        inside:
          kind: export_statement
      has:
        kind: variable_declarator
        has:
          field: name
          regex: "^${escapedName}$"
    - kind: class_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: "^${escapedName}$"
    - kind: interface_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: "^${escapedName}$"
    - kind: type_alias_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: "^${escapedName}$"
    - kind: method_definition
      has:
        field: name
        regex: "^${escapedName}$"
`;
}

/**
 * Infers the high-level kind of symbol from the matched snippet.
 */
export function inferSymbolKind(codeSnippet: string): SymbolKind {
  const trimmed = codeSnippet.trim();
  if (/^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed)) {
    return 'function';
  }
  if (/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed) ||
      /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?[A-Za-z0-9_$]+\s*=>/.test(trimmed)) {
    return 'arrow-function';
  }
  if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(trimmed)) {
    return 'class';
  }
  if (/^(?:export\s+)?interface\b/.test(trimmed)) {
    return 'interface';
  }
  if (/^(?:export\s+)?type\b/.test(trimmed)) {
    return 'type';
  }
  if (/^(?:export\s+)?(?:const|let|var)\b/.test(trimmed)) {
    return 'variable';
  }
  return 'function';
}

/**
 * Extracts function/method signature if available.
 */
export function extractSignature(codeSnippet: string): string | undefined {
  const firstLine = codeSnippet.split('\n')[0].trim();
  if (firstLine.includes('{')) {
    return firstLine.substring(0, firstLine.indexOf('{')).trim();
  }
  if (firstLine.endsWith(';')) {
    return firstLine.slice(0, -1).trim();
  }
  return firstLine;
}

/**
 * Finds internal calls or identifiers used within a code slice.
 * Supports direct calls (fn()) and namespace member calls (ns.fn()), capped at maxCalls (default: 30).
 */
export function extractInternalCalls(codeSnippet: string, selfSymbol: string, maxCalls: number = 30): string[] {
  const callRegex = /(?:([A-Za-z0-9_$]+)\.)?([A-Za-z0-9_$]+)\s*\(/g;
  const calls = new Set<string>();
  const keywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'import', 'export', 'return',
    'function', 'require', 'typeof', 'instanceof', 'void', 'delete', selfSymbol
  ]);
  const ignoredObjects = new Set([
    'this', 'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'Reflect', 'Symbol'
  ]);

  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(codeSnippet)) !== null) {
    const obj = match[1];
    const fn = match[2];

    if (obj && !ignoredObjects.has(obj) && fn.length > 1) {
      calls.add(`${obj}.${fn}`);
    } else if (!keywords.has(fn) && fn.length > 1) {
      calls.add(fn);
    }
  }

  return Array.from(calls).slice(0, maxCalls);
}

/**
 * Precision symbol slicer: extracts the verbatim declaration body of a symbol with line numbers and callers.
 */
export async function sliceSymbol(options: SliceSymbolOptions): Promise<SymbolSliceResult | null> {
  const targetFile = resolve(options.path);
  let fileContent: string;
  try {
    fileContent = await readSourceFile(targetFile);
  } catch {
    throw new Error(`Failed to read file: ${targetFile}`);
  }

  const adapter = createDocumentAdapter(targetFile, fileContent);
  const scriptBlocks = adapter.getScriptBlocks();
  if (scriptBlocks.length === 0) {
    return null;
  }

  const fileLines = fileContent.split('\n');
  const ext = extname(targetFile).toLowerCase();
  const isJsx = ext === '.jsx' || ext === '.tsx' || adapter.isJsx();
  const targetLang = isJsx ? 'tsx' : 'ts';

  for (const block of scriptBlocks) {
    const blockLang = (block.lang === 'jsx' || block.lang === 'tsx') ? 'tsx' : targetLang;
    const ruleYaml = buildSymbolRuleYaml(options.symbolName, blockLang);
    let matches: RawMatch[];
    try {
      matches = await executeAstGrep({
        rule: ruleYaml,
        code: block.content,
        language: blockLang,
      });
    } catch {
      continue;
    }

    if (matches.length === 0) {
      continue;
    }

    // Pick the most comprehensive match (e.g. export_statement over inner declaration)
    const bestMatch = matches[0];
    const blockStart = block.loc.start;

    const start = remapPosition(bestMatch.line, bestMatch.column, blockStart);
    const end = bestMatch.endLine
      ? remapPosition(bestMatch.endLine, bestMatch.endColumn || 1, blockStart)
      : { line: start.line + bestMatch.text.split('\n').length - 1, column: 1 };

    const startLine = Math.max(1, start.line);
    const endLine = Math.min(fileLines.length, end.line);

    // Extract verbatim lines from original file
    const slicedLines = fileLines.slice(startLine - 1, endLine);
    const formattedCode = slicedLines
      .map((line, idx) => `${startLine + idx}: ${line}`)
      .join('\n');

    const rawCode = slicedLines.join('\n');
    const kind = inferSymbolKind(bestMatch.text);
    const signature = extractSignature(bestMatch.text);
    const internalCalls = extractInternalCalls(rawCode, options.symbolName);

    // Blast radius resolution
    let blastRadius: SymbolSliceResult['blastRadius'];
    if (options.includeBlastRadius !== false) {
      const workspaceRoot = options.workspaceRoot || findProjectRoot(targetFile) || dirname(targetFile);
      try {
        const db = getWorkspaceDatabase(workspaceRoot);
        const callersList: Array<{ filePath: string; line?: number }> = [];

        // Check if callers imported this state/symbol via state_deps
        const stateRows = db
          .query('SELECT files.path FROM state_deps JOIN files ON files.id = state_deps.file_id WHERE state_deps.identifier = ?')
          .all(options.symbolName) as Array<{ path: string }>;

        for (const row of stateRows) {
          if (row.path !== targetFile && !callersList.some(c => c.filePath === row.path)) {
            callersList.push({ filePath: row.path });
          }
        }

        // Check edges (files importing targetFile)
        const edgeRows = db
          .query(`
            SELECT files.path 
            FROM edges 
            JOIN files ON files.id = edges.parent_file_id 
            WHERE edges.child_file_id = (SELECT id FROM files WHERE path = ?)
          `)
          .all(targetFile) as Array<{ path: string }>;

        for (const row of edgeRows) {
          if (row.path !== targetFile && !callersList.some(c => c.filePath === row.path)) {
            callersList.push({ filePath: row.path });
          }
        }

        const isTestFile = (p: string) => {
          const norm = p.replace(/\\/g, '/').toLowerCase();
          return (
            norm.includes('/tests/') ||
            norm.includes('/__tests__/') ||
            norm.includes('.test.') ||
            norm.includes('.spec.')
          );
        };

        const productionCallers = callersList.filter((c) => !isTestFile(c.filePath));
        const coveringTests = callersList
          .filter((c) => isTestFile(c.filePath))
          .map((c) => c.filePath);

        blastRadius = {
          totalConsumers: productionCallers.length,
          callers: productionCallers,
          coveringTests,
          internalCalls,
        };
      } catch {
        blastRadius = {
          totalConsumers: 0,
          callers: [],
          coveringTests: [],
          internalCalls,
        };
      }
    }

    const lineCount = endLine - startLine + 1;
    const maxDisplayLines = options.maxDisplayLines ?? 50;
    let finalCode = formattedCode;
    let isTruncated = false;

    if (lineCount > maxDisplayLines) {
      isTruncated = true;
      const head = slicedLines.slice(0, 10).map((line, idx) => `${startLine + idx}: ${line}`);
      const tail = slicedLines.slice(-5).map((line, idx) => `${endLine - 5 + idx + 1}: ${line}`);
      finalCode = [
        ...head,
        `  // ... [TRUNCATED: ${lineCount - 15} lines omitted to prevent context bloat] ...`,
        `  // Use view_file(StartLine: ${startLine}, EndLine: ${endLine}) to read targeted lines`,
        ...tail,
      ].join('\n');
    }

    const complexitySmell =
      lineCount > 300
        ? {
            isHighComplexity: true,
            threshold: 300,
            totalLines: lineCount,
            warning: `Symbol '${options.symbolName}' spans ${lineCount} lines (exceeds 300-line threshold). Candidate for decomposition/refactoring.`,
          }
        : undefined;

    return {
      symbolName: options.symbolName,
      kind,
      filePath: targetFile,
      startLine,
      endLine,
      code: finalCode,
      signature,
      complexitySmell,
      blastRadius,
      isTruncated,
    };
  }

  return null;
}

/**
 * Formats a SymbolSliceResult as compact markdown.
 */
export function formatSymbolSliceAsText(result: SymbolSliceResult): string {
  const lines: string[] = [];
  lines.push(`### Symbol: \`${result.symbolName}\` (${result.kind})`);
  lines.push(`**File:** \`${result.filePath}:${result.startLine}-${result.endLine}\``);

  if (result.complexitySmell) {
    lines.push(`\n⚠️ **High-Complexity Smell (${result.complexitySmell.totalLines} lines):** ${result.complexitySmell.warning}`);
  }

  if (result.signature) {
    lines.push(`**Signature:** \`${result.signature}\``);
  }

  if (result.isTruncated) {
    const lineCount = result.endLine - result.startLine + 1;
    lines.push(`\n⚠️ **Context Guard Notice:** Symbol spans ${lineCount} lines (exceeds 50-line dump threshold). Truncated to preview.`);
    lines.push(`> [!TIP] Gunakan \`view_file\` dengan parameter \`StartLine: ${result.startLine}\` dan \`EndLine: ${result.endLine}\` untuk membaca bagian yang diperlukan secara presisi tanpa context rot.\n`);
  }

  lines.push('\n```typescript');
  lines.push(result.code);
  lines.push('```\n');

  if (result.blastRadius) {
    lines.push('**Blast Radius:**');
    if (result.blastRadius.callers.length > 0) {
      lines.push(`- Consumers (${result.blastRadius.totalConsumers} files):`);
      for (const caller of result.blastRadius.callers.slice(0, 10)) {
        lines.push(`  - \`${caller.filePath}\``);
      }
      if (result.blastRadius.callers.length > 10) {
        lines.push(`  - ... and ${result.blastRadius.callers.length - 10} more files`);
      }
    } else {
      lines.push('- Consumers: None found in workspace index');
    }

    if (result.blastRadius.coveringTests && result.blastRadius.coveringTests.length > 0) {
      lines.push(`- Covering tests: \`${result.blastRadius.coveringTests.slice(0, 5).join('`, `')}\``);
    } else {
      lines.push('- Covering tests: ⚠️ no covering tests found');
    }

    if (result.blastRadius.internalCalls && result.blastRadius.internalCalls.length > 0) {
      lines.push(`- Internal calls: \`${result.blastRadius.internalCalls.join('`, `')}\``);
    }
  }

  return lines.join('\n');
}
