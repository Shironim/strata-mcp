import * as ts from 'typescript';
import { readSourceFile } from './source-file';
import { promises as fs } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { executeAstGrep } from './astgrep';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { getWorkspaceDatabase } from './database';
import { canonicalizePath, findProjectRoot } from './path-resolver';
import { escapeRegExp } from './patterns';
import { resolveModuleFilePath, extractImportedSymbols, resolveCalleesForCalls } from './symbol-resolver';
import type { RawMatch, SliceSymbolOptions, SymbolKind, SymbolSliceResult, ResolvedCalleeReference } from '../types';

/**
 * Builds an ast-grep rule YAML to locate the declaration of a specific symbol.
 */
export function buildSymbolRuleYaml(symbolName: string, lang: string = 'ts'): string {
  const safeLang = lang === 'jsx' || lang === 'tsx' ? 'tsx' : 'ts';
  const escapedName = escapeRegExp(symbolName);
  const yamlRegex = escapedName.replace(/'/g, "''");

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
              regex: '^${yamlRegex}$'
          - kind: lexical_declaration
            has:
              kind: variable_declarator
              has:
                field: name
                regex: '^${yamlRegex}$'
          - kind: class_declaration
            has:
              field: name
              regex: '^${yamlRegex}$'
          - kind: interface_declaration
            has:
              field: name
              regex: '^${yamlRegex}$'
          - kind: type_alias_declaration
            has:
              field: name
              regex: '^${yamlRegex}$'
    - kind: function_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: '^${yamlRegex}$'
    - kind: lexical_declaration
      not:
        inside:
          kind: export_statement
      has:
        kind: variable_declarator
        has:
          field: name
          regex: '^${yamlRegex}$'
    - kind: class_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: '^${yamlRegex}$'
    - kind: interface_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: '^${yamlRegex}$'
    - kind: type_alias_declaration
      not:
        inside:
          kind: export_statement
      has:
        field: name
        regex: '^${yamlRegex}$'
    - kind: method_definition
      has:
        field: name
        regex: '^${yamlRegex}$'
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
 * Finds internal calls or identifiers used within a code slice using TypeScript AST parser.
 * Supports direct calls (fn()) and namespace member calls (ns.fn()), capped at maxCalls (default: 30).
 * Ignores comments and string literals.
 */
export function extractInternalCalls(codeSnippet: string, selfSymbol: string, maxCalls: number = 30): string[] {
  const calls = new Set<string>();
  const keywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'import', 'export', 'return',
    'function', 'require', 'typeof', 'instanceof', 'void', 'delete', selfSymbol
  ]);
  const ignoredObjects = new Set([
    'this', 'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'Reflect', 'Symbol'
  ]);

  try {
    const sourceFile = ts.createSourceFile(
      'snippet.tsx',
      codeSnippet,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    function visit(node: ts.Node) {
      if (calls.size >= maxCalls) return;

      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isIdentifier(expr)) {
          const fn = expr.text;
          if (!keywords.has(fn) && fn.length > 1) {
            calls.add(fn);
          }
        } else if (ts.isPropertyAccessExpression(expr)) {
          if (ts.isIdentifier(expr.expression) && ts.isIdentifier(expr.name)) {
            const obj = expr.expression.text;
            const fn = expr.name.text;
            if (obj && !ignoredObjects.has(obj) && fn.length > 1) {
              calls.add(`${obj}.${fn}`);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch {
    // Graceful fallback
  }

  return Array.from(calls).slice(0, maxCalls);
}

interface CandidateVerification {
  isCaller: boolean;
  isCandidate: boolean;
  line?: number;
  reason?: string;
}

async function verifyCandidateCaller(
  candPath: string,
  targetFile: string,
  symbolName: string,
  workspaceRoot: string
): Promise<CandidateVerification> {
  try {
    const content = await readSourceFile(candPath);
    const adapter = createDocumentAdapter(candPath, content);
    const scriptBlocks = adapter.getScriptBlocks();
    const templateBlock = adapter.getTemplateBlock();
    const ext = extname(candPath).toLowerCase();
    const isJsx = ext === '.tsx' || ext === '.jsx' || adapter.isJsx();

    let importsTarget = false;
    let localAlias: string | null = null;
    let isNamespace = false;
    let nsName = '';
    let isReExport = false;

    // 1. Check imports across script blocks
    for (const block of scriptBlocks) {
      const sourceFile = ts.createSourceFile(
        candPath,
        block.content,
        ts.ScriptTarget.Latest,
        true,
        isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const spec = stmt.moduleSpecifier.text;
          const resolved = resolveModuleFilePath(candPath, spec, workspaceRoot);
          if (resolved && canonicalizePath(resolved) === canonicalizePath(targetFile)) {
            importsTarget = true;
            const clause = stmt.importClause;
            if (clause) {
              if (clause.name && (symbolName === 'default' || symbolName === clause.name.text)) {
                localAlias = clause.name.text;
              }
              if (clause.namedBindings) {
                if (ts.isNamedImports(clause.namedBindings)) {
                  for (const el of clause.namedBindings.elements) {
                    const orig = el.propertyName ? el.propertyName.text : el.name.text;
                    if (orig === symbolName) {
                      localAlias = el.name.text;
                      break;
                    }
                  }
                } else if (ts.isNamespaceImport(clause.namedBindings)) {
                  isNamespace = true;
                  nsName = clause.namedBindings.name.text;
                }
              }
            }
          }
        } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const spec = stmt.moduleSpecifier.text;
          const resolved = resolveModuleFilePath(candPath, spec, workspaceRoot);
          if (resolved && canonicalizePath(resolved) === canonicalizePath(targetFile)) {
            importsTarget = true;
            if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
              for (const el of stmt.exportClause.elements) {
                const orig = el.propertyName ? el.propertyName.text : el.name.text;
                if (orig === symbolName) {
                  isReExport = true;
                  break;
                }
              }
            } else if (!stmt.exportClause) {
              isReExport = true;
            }
          }
        }
      }
    }

    if (!importsTarget) {
      // Could be state dep without direct import edge
      // Check if symbolName is used in script or template
      for (const block of scriptBlocks) {
        const sourceFile = ts.createSourceFile(
          candPath,
          block.content,
          ts.ScriptTarget.Latest,
          true,
          isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        let foundLine: number | undefined;
        function findSym(node: ts.Node) {
          if (foundLine !== undefined) return;
          if (ts.isIdentifier(node) && node.text === symbolName) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const remapped = remapPosition(pos.line + 1, pos.character + 1, block.loc.start);
            foundLine = remapped.line;
            return;
          }
          ts.forEachChild(node, findSym);
        }
        findSym(sourceFile);
        if (foundLine !== undefined) {
          return { isCaller: true, isCandidate: false, line: foundLine };
        }
      }
      return { isCaller: false, isCandidate: false };
    }

    // Re-export without local call
    if (isReExport && !localAlias && !isNamespace) {
      return { isCaller: false, isCandidate: true, reason: 're-exported symbol' };
    }

    // If localAlias was found, search for usages
    if (localAlias) {
      for (const block of scriptBlocks) {
        const sourceFile = ts.createSourceFile(
          candPath,
          block.content,
          ts.ScriptTarget.Latest,
          true,
          isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        let foundLine: number | undefined;

        function findUsage(node: ts.Node) {
          if (foundLine !== undefined) return;
          // Ignore the import declaration itself
          if (ts.isImportSpecifier(node) || ts.isImportClause(node)) return;

          if (ts.isIdentifier(node) && node.text === localAlias) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const remapped = remapPosition(pos.line + 1, pos.character + 1, block.loc.start);
            foundLine = remapped.line;
            return;
          }
          ts.forEachChild(node, findUsage);
        }

        findUsage(sourceFile);
        if (foundLine !== undefined) {
          return { isCaller: true, isCandidate: false, line: foundLine };
        }
      }

      // Check template block (e.g. Vue template)
      if (templateBlock) {
        const lines = templateBlock.content.split('\n');
        const pattern = new RegExp(`\\b${escapeRegExp(localAlias)}\\b`);
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            const remapped = remapPosition(i + 1, 1, templateBlock.loc.start);
            return { isCaller: true, isCandidate: false, line: remapped.line };
          }
        }
      }

      // If imported in <script setup>, it is exposed to template or scope
      const isScriptSetup = scriptBlocks.some((b) => Boolean(b.attrs?.['setup']));
      if (isScriptSetup) {
        return { isCaller: true, isCandidate: false, line: scriptBlocks[0]?.loc?.start?.line };
      }

      return { isCaller: false, isCandidate: true, reason: 'symbol imported but no static call site found' };
    }

    if (isNamespace) {
      // Search for ns.symbolName
      for (const block of scriptBlocks) {
        const sourceFile = ts.createSourceFile(
          candPath,
          block.content,
          ts.ScriptTarget.Latest,
          true,
          isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        let foundLine: number | undefined;

        function findNsUsage(node: ts.Node) {
          if (foundLine !== undefined) return;
          if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === nsName &&
            node.name.text === symbolName
          ) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const remapped = remapPosition(pos.line + 1, pos.character + 1, block.loc.start);
            foundLine = remapped.line;
            return;
          }
          ts.forEachChild(node, findNsUsage);
        }

        findNsUsage(sourceFile);
        if (foundLine !== undefined) {
          return { isCaller: true, isCandidate: false, line: foundLine };
        }
      }

      return { isCaller: false, isCandidate: true, reason: 'namespace import without static member call' };
    }

    return { isCaller: false, isCandidate: false };
  } catch {
    return { isCaller: false, isCandidate: false };
  }
}

/**
 * Precision symbol slicer: extracts the verbatim declaration body of a symbol with line numbers and callers.
 */
export async function sliceSymbol(options: SliceSymbolOptions): Promise<SymbolSliceResult | null> {
  const targetFile = canonicalizePath(resolve(options.path));
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

    // 1-hop cross-file callee resolution
    const workspaceRoot = options.workspaceRoot || findProjectRoot(targetFile) || dirname(targetFile);
    let resolvedCallees: ResolvedCalleeReference[] = [];
    try {
      const importedSymbols = extractImportedSymbols(targetFile, fileContent);
      resolvedCallees = await resolveCalleesForCalls(
        internalCalls,
        targetFile,
        importedSymbols,
        workspaceRoot
      );
    } catch {
      // Graceful fallback
    }

    // Blast radius resolution
    let blastRadius: SymbolSliceResult['blastRadius'];
    if (options.includeBlastRadius !== false) {
      try {
        const { isWorkspaceIndexed } = await import('./storage/schema');
        if (!isWorkspaceIndexed(workspaceRoot)) throw new Error('Workspace is not indexed');
        const { syncWorkspace } = await import('./storage/delta-sync');
        await syncWorkspace(workspaceRoot);

        const db = getWorkspaceDatabase(workspaceRoot);
        const rawCandidateFiles: string[] = [];

        // Check if callers imported this state/symbol via state_deps
        const stateRows = db
          .query('SELECT files.path FROM state_deps JOIN files ON files.id = state_deps.file_id WHERE state_deps.identifier = ?')
          .all(options.symbolName) as Array<{ path: string }>;

        for (const row of stateRows) {
          if (row.path !== targetFile && !rawCandidateFiles.includes(row.path)) {
            rawCandidateFiles.push(row.path);
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
          if (row.path !== targetFile && !rawCandidateFiles.includes(row.path)) {
            rawCandidateFiles.push(row.path);
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

        const confirmedCallers: Array<{ filePath: string; line?: number }> = [];
        const candidateImporters: Array<{ filePath: string; reason?: string }> = [];

        for (const candFile of rawCandidateFiles) {
          const verification = await verifyCandidateCaller(
            candFile,
            targetFile,
            options.symbolName,
            workspaceRoot
          );
          if (verification.isCaller) {
            confirmedCallers.push({ filePath: candFile, line: verification.line });
          } else if (verification.isCandidate) {
            candidateImporters.push({ filePath: candFile, reason: verification.reason });
          }
        }

        const productionCallers = confirmedCallers.filter((c) => !isTestFile(c.filePath));
        const coveringTests = confirmedCallers
          .filter((c) => isTestFile(c.filePath))
          .map((c) => c.filePath);

        const status = candidateImporters.length > 0 ? 'partial' : 'resolved';

        blastRadius = {
          status,
          totalConsumers: productionCallers.length,
          callers: productionCallers,
          confirmedCallers: productionCallers,
          candidateImporters,
          coveringTests,
          internalCalls,
          resolvedCalls: resolvedCallees,
          resolvedCallees,
        };
      } catch (error) {
        blastRadius = {
          status: 'unknown',
          reason: error instanceof Error ? error.message : String(error),
          totalConsumers: null,
          callers: [],
          confirmedCallers: [],
          candidateImporters: [],
          coveringTests: [],
          internalCalls,
          resolvedCalls: resolvedCallees,
          resolvedCallees,
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
        `  // Use inspect_component(path: "${targetFile}", source_range: { start_line: ${startLine}, end_line: ${endLine} }) to read targeted lines`,
        ...tail,
      ].join('\n');
    }

    return {
      symbolName: options.symbolName,
      kind,
      filePath: targetFile,
      startLine,
      endLine,
      code: finalCode,
      signature,
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

  if (result.signature) {
    lines.push(`**Signature:** \`${result.signature}\``);
  }

  if (result.isTruncated) {
    const lineCount = result.endLine - result.startLine + 1;
    lines.push(`\n⚠️ **Context Guard Notice:** Symbol spans ${lineCount} lines (exceeds 50-line dump threshold). Truncated to preview.`);
    lines.push(`> [!TIP] Gunakan \`inspect_component\` dengan parameter \`path: "${result.filePath}"\`, \`source_range: { start_line: ${result.startLine}, end_line: ${result.endLine} }\` untuk membaca bagian yang diperlukan secara presisi tanpa context rot.\n`);
  }

  lines.push('\n```typescript');
  lines.push(result.code);
  lines.push('```\n');

  if (result.blastRadius) {
    lines.push('**Blast Radius:**');
    if (result.blastRadius.status === 'unknown') {
      lines.push(`- Consumers and covering tests: unknown (${result.blastRadius.reason})`);
    } else if (result.blastRadius.callers.length > 0) {
      lines.push(`- Consumers (${result.blastRadius.totalConsumers} files):`);
      for (const caller of result.blastRadius.callers.slice(0, 10)) {
        const lineSuffix = caller.line ? `:${caller.line}` : '';
        lines.push(`  - \`${caller.filePath}${lineSuffix}\``);
      }
      if (result.blastRadius.callers.length > 10) {
        lines.push(`  - ... and ${result.blastRadius.callers.length - 10} more files`);
      }
    } else {
      lines.push('- Consumers: None found in workspace index');
    }

    if (result.blastRadius.status !== 'unknown') {
      if (result.blastRadius.coveringTests?.length) {
        lines.push(`- Covering tests: \`${result.blastRadius.coveringTests.slice(0, 5).join('\`, \`')}\``);
      } else {
        lines.push('- Covering tests: ⚠️ no covering tests found');
      }
    }
    if (result.blastRadius.candidateImporters && result.blastRadius.candidateImporters.length > 0) {
      lines.push(`- Candidate importers (${result.blastRadius.candidateImporters.length} files):`);
      for (const cand of result.blastRadius.candidateImporters.slice(0, 5)) {
        lines.push(`  - \`${cand.filePath}\`${cand.reason ? ` (${cand.reason})` : ''}`);
      }
    }
    if (result.blastRadius.internalCalls && result.blastRadius.internalCalls.length > 0) {
      lines.push(`- Internal calls: \`${result.blastRadius.internalCalls.join('`, `')}\``);
    }
    if (result.blastRadius.resolvedCallees && result.blastRadius.resolvedCallees.length > 0) {
      lines.push('- Resolved callees (1-hop):');
      for (const callee of result.blastRadius.resolvedCallees.slice(0, 10)) {
        const range = callee.targetRange ? `:${callee.targetRange.startLine}-${callee.targetRange.endLine}` : '';
        lines.push(`  - \`${callee.symbol}\` -> \`${callee.targetFilePath || callee.sourceModule}${range}\``);
      }
    }
  }

  return lines.join('\n');
}
