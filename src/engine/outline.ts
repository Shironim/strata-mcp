import { readSourceFile } from './source-file';
import { loadTsConfigHierarchySync } from './resolver';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { extractInternalCalls } from './slicer';
import { canonicalizePath, findProjectRoot, resolveWorkspacePath } from './path-resolver';
import type {
  ComponentSymbolOutline,
  ExtractOutlineOptions,
  FunctionOutlineItem,
  ResolvedCalleeReference,
} from '../types';

import {
  clearTsConfigCache,
  loadTsConfigPaths,
  resolveModuleFilePath,
  locateTargetSymbolLines,
  extractImportedSymbols,
  resolveCalleesForCalls,
  type TargetSymbolResult,
  type ImportedSymbolInfo,
  type TsConfigPaths,
} from './symbol-resolver';

export {
  clearTsConfigCache,
  loadTsConfigPaths,
  resolveModuleFilePath,
  locateTargetSymbolLines,
  extractImportedSymbols,
  resolveCalleesForCalls,
  type TargetSymbolResult,
  type ImportedSymbolInfo,
  type TsConfigPaths,
};

/**
 * Extracts a complete outline of all declared functions and methods in a component file,
 * with exact start/end line bounds, 1-hop cross-file callee resolution, and complexity smell detection.
 */
export async function extractComponentOutline(
  filePath: string,
  options: ExtractOutlineOptions = { path: filePath }
): Promise<ComponentSymbolOutline> {
  const targetFile = resolve(filePath);
  const fileContent = await readSourceFile(targetFile);
  const workspaceRoot = options.workspaceRoot || findProjectRoot(targetFile) || dirname(targetFile);
  const threshold = options.maxFunctionLines ?? 300;
  const shouldResolveCalls = options.resolveCalls !== false;

  const adapter = createDocumentAdapter(targetFile, fileContent);
  const scriptBlocks = adapter.getScriptBlocks();

  const ext = extname(targetFile).toLowerCase();
  let framework = 'unknown';
  if (ext === '.vue') framework = 'vue';
  else if (ext === '.tsx' || ext === '.jsx') framework = 'react';
  else if (ext === '.astro') framework = 'astro';
  else if (ext === '.ts' || ext === '.js') framework = 'ts-module';

  const functions: FunctionOutlineItem[] = [];
  const importedSymbols = new Map<string, ImportedSymbolInfo>();

  for (const block of scriptBlocks) {
    const isJsx = ext === '.tsx' || ext === '.jsx' || adapter.isJsx();
    const sourceFile = ts.createSourceFile(
      targetFile,
      block.content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    // 1. Collect all import statements in this block
    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const moduleSpecifier = stmt.moduleSpecifier.getText(sourceFile).replace(/^['"]|['"]$/g, '');
        const clause = stmt.importClause;
        if (clause) {
          if (clause.name) {
            importedSymbols.set(clause.name.text, {
              importedName: clause.name.text,
              sourceModule: moduleSpecifier,
            });
          }
          if (clause.namedBindings) {
            if (ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                importedSymbols.set(el.name.text, {
                  importedName: el.propertyName ? el.propertyName.text : el.name.text,
                  sourceModule: moduleSpecifier,
                });
              }
            } else if (ts.isNamespaceImport(clause.namedBindings)) {
              importedSymbols.set(clause.namedBindings.name.text, {
                importedName: '*',
                sourceModule: moduleSpecifier,
              });
            }
          }
        }
      }
    }

    // 2. Collect functions, methods, computed properties, and watchers
    function registerFunctionItem(
      fnName: string,
      kind: FunctionOutlineItem['kind'],
      targetNode: ts.Node,
      isExported: boolean
    ) {
      if (!fnName) return;

      const tsStart = sourceFile.getLineAndCharacterOfPosition(targetNode.getStart(sourceFile));
      const tsEnd = sourceFile.getLineAndCharacterOfPosition(targetNode.getEnd());
      const remappedStart = remapPosition(tsStart.line + 1, tsStart.character + 1, block.loc.start);
      const remappedEnd = remapPosition(tsEnd.line + 1, tsEnd.character + 1, block.loc.start);

      const startLine = Math.max(1, remappedStart.line);
      const endLine = Math.max(startLine, remappedEnd.line);
      const lineCount = Math.max(1, endLine - startLine + 1);

      const nodeText = targetNode.getText(sourceFile);
      const firstLine = nodeText.split('\n')[0].trim();
      const signature = firstLine.endsWith('{') ? firstLine.slice(0, -1).trim() : firstLine;

      const internalCalls = extractInternalCalls(nodeText, fnName, 30);

      const item: FunctionOutlineItem = {
        name: fnName,
        kind,
        startLine,
        endLine,
        lineCount,
        signature,
        isExported,
        internalCalls,
      };

      if (lineCount > threshold) {
        item.complexitySmell = {
          isHighComplexity: true,
          threshold,
          totalLines: lineCount,
          warning: `Function '${fnName}' spans ${lineCount} lines (exceeds ${threshold}-line threshold). Candidate for decomposition/refactoring.`,
        };
      }

      functions.push(item);
    }

    function isNodeExported(node: ts.Node): boolean {
      if (ts.canHaveModifiers(node)) {
        for (const mod of ts.getModifiers(node) ?? []) {
          if (mod.kind === ts.SyntaxKind.ExportKeyword) return true;
        }
      }
      return false;
    }

    function inspectNode(node: ts.Node) {
      if (ts.isFunctionDeclaration(node)) {
        const fnName = node.name ? node.name.text : 'anonymous_function';
        registerFunctionItem(fnName, 'function', node, isNodeExported(node));
      } else if (ts.isVariableStatement(node)) {
        const exported = isNodeExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const init = decl.initializer;
            const name = decl.name.text;
            if (ts.isArrowFunction(init)) {
              registerFunctionItem(name, 'arrow-function', decl, exported);
            } else if (ts.isFunctionExpression(init)) {
              registerFunctionItem(name, 'function', decl, exported);
            } else if (ts.isCallExpression(init)) {
              const callText = init.expression.getText(sourceFile);
              if (callText === 'computed') {
                registerFunctionItem(name, 'computed', decl, exported);
              } else if (callText === 'watch' || callText === 'watchEffect') {
                registerFunctionItem(name, 'watcher', decl, exported);
              } else if (callText.startsWith('use')) {
                registerFunctionItem(name, 'composable', decl, exported);
              }
            }
          }
        }
      } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const callText = node.expression.expression.getText(sourceFile);
        if (callText === 'watch' || callText === 'watchEffect') {
          const tsStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          registerFunctionItem(`${callText}_L${tsStart.line + 1}`, 'watcher', node, false);
        }
      } else if (ts.isMethodDeclaration(node)) {
        const fnName = node.name.getText(sourceFile);
        registerFunctionItem(fnName, 'method', node, isNodeExported(node));
      }

      ts.forEachChild(node, inspectNode);
    }

    inspectNode(sourceFile);
  }

  // 3. 1-hop cross-file callee resolution
  const trackedDeps = new Map<string, string>();
  if (shouldResolveCalls) {
    const resolvedCache = new Map<string, ResolvedCalleeReference>();

    for (const fn of functions) {
      const resolvedCalls = await resolveCalleesForCalls(
        fn.internalCalls,
        targetFile,
        importedSymbols,
        workspaceRoot,
        resolvedCache,
        trackedDeps
      );

      if (resolvedCalls.length > 0) {
        fn.resolvedCalls = resolvedCalls;
      }
    }
  }

  const highComplexityCount = functions.filter((f) => f.complexitySmell?.isHighComplexity).length;

  const dependencies = trackedDeps.size > 0
    ? Array.from(trackedDeps.entries()).map(([p, hash]) => ({
        path: p,
        hash,
        isExternal: !p.startsWith(canonicalizePath(workspaceRoot)),
      }))
    : undefined;

  return {
    filePath: targetFile,
    framework,
    totalFunctions: functions.length,
    highComplexityCount,
    functions,
    ...(dependencies ? { dependencies } : {}),
  };
}

/**
 * Formats a ComponentSymbolOutline as clean, readable Markdown for AI Agent selective context.
 */
export function formatOutlineAsText(outline: ComponentSymbolOutline): string {
  const lines: string[] = [];
  lines.push(`### Component Symbol Outline: \`${outline.filePath}\``);
  lines.push(`**Framework:** ${outline.framework} | **Total Functions:** ${outline.totalFunctions} | **High-Complexity Functions:** ${outline.highComplexityCount}`);

  if (outline.functions.length === 0) {
    lines.push('\n_No function or method declarations found in script blocks._');
    return lines.join('\n');
  }

  lines.push('\n| Function / Symbol | Kind | Range | Lines | Exported | Complexity |');
  lines.push('|---|---|---|---|---|---|');

  for (const fn of outline.functions) {
    const range = `L${fn.startLine}-L${fn.endLine}`;
    const exportedBadge = fn.isExported ? 'yes' : 'no';
    const complexityBadge = fn.complexitySmell ? `⚠️ SMELL (> ${fn.complexitySmell.threshold}L)` : 'healthy';
    lines.push(`| \`${fn.name}\` | ${fn.kind} | \`${range}\` | ${fn.lineCount} | ${exportedBadge} | ${complexityBadge} |`);
  }

  // Cross-file call resolution section
  const functionsWithCalls = outline.functions.filter((f) => f.resolvedCalls && f.resolvedCalls.length > 0);
  if (functionsWithCalls.length > 0) {
    lines.push('\n#### Cross-File Callee Line Mappings (1-Hop):');
    for (const fn of functionsWithCalls) {
      lines.push(`- **\`${fn.name}\`** (L${fn.startLine}-L${fn.endLine}):`);
      for (const call of fn.resolvedCalls || []) {
        if (call.targetFilePath && call.targetRange) {
          lines.push(`  - Calls \`${call.symbol}\` ➔ \`${call.targetFilePath}:L${call.targetRange.startLine}-L${call.targetRange.endLine}\` (${call.targetRange.lineCount} lines)`);
        } else if (call.targetFilePath) {
          lines.push(`  - Calls \`${call.symbol}\` ➔ \`${call.targetFilePath}\` (range unindexed)`);
        } else {
          lines.push(`  - Calls \`${call.symbol}\` ➔ module \`${call.sourceModule}\``);
        }
      }
    }
  }

  // Complexity smell recommendations
  const smellyFunctions = outline.functions.filter((f) => f.complexitySmell);
  if (smellyFunctions.length > 0) {
    lines.push('\n#### ⚠️ High-Complexity Refactoring Smells:');
    for (const fn of smellyFunctions) {
      lines.push(`- **\`${fn.name}\`** (${fn.lineCount} lines, \`L${fn.startLine}-L${fn.endLine}\`): ${fn.complexitySmell?.warning}`);
    }
  }

  return lines.join('\n');
}
