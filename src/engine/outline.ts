import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { extractInternalCalls } from './slicer';
import { findProjectRoot, resolveWorkspacePath } from './path-resolver';
import type {
  ComponentSymbolOutline,
  ExtractOutlineOptions,
  FunctionOutlineItem,
  ResolvedCalleeReference,
} from '../types';

interface ImportedSymbolInfo {
  importedName: string;
  sourceModule: string;
}

interface TsConfigPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

const tsConfigCache = new Map<string, TsConfigPaths | null>();

/**
 * Loads and caches compilerOptions.paths from tsconfig.json or jsconfig.json.
 */
function loadTsConfigPaths(workspaceRoot: string): TsConfigPaths | null {
  if (tsConfigCache.has(workspaceRoot)) {
    return tsConfigCache.get(workspaceRoot)!;
  }

  const candidateFiles = ['tsconfig.json', 'jsconfig.json'];
  for (const configFile of candidateFiles) {
    const fullPath = join(workspaceRoot, configFile);
    if (existsSync(fullPath)) {
      try {
        const raw = readFileSync(fullPath, 'utf8');
        const stripped = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        const parsed = JSON.parse(stripped);
        const compilerOptions = parsed?.compilerOptions;
        if (compilerOptions?.paths) {
          const config: TsConfigPaths = {
            baseUrl: compilerOptions.baseUrl ? resolve(workspaceRoot, compilerOptions.baseUrl) : workspaceRoot,
            paths: compilerOptions.paths,
          };
          tsConfigCache.set(workspaceRoot, config);
          return config;
        }
      } catch {
        // Graceful fallback
      }
    }
  }

  tsConfigCache.set(workspaceRoot, null);
  return null;
}

/**
 * Resolves an imported module specifier to an absolute file path.
 * Supports relative paths, tsconfig/jsconfig paths mapping, and standard fallback aliases (@/, ~/).
 */
function resolveModuleFilePath(currentFile: string, moduleSpecifier: string, workspaceRoot: string): string | null {
  const cleanSpec = moduleSpecifier.trim().replace(/^['"]|['"]$/g, '');
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs'];

  const tryCandidate = (candidateBase: string): string | null => {
    if (existsSync(candidateBase) && !existsSync(candidateBase + '/')) {
      return candidateBase;
    }
    for (const ext of extensions) {
      if (existsSync(candidateBase + ext)) return candidateBase + ext;
    }
    for (const ext of extensions) {
      const indexFile = join(candidateBase, `index${ext}`);
      if (existsSync(indexFile)) return indexFile;
    }
    return null;
  };

  // 1. Relative imports
  if (cleanSpec.startsWith('.')) {
    const dir = dirname(currentFile);
    const candidateBase = resolve(dir, cleanSpec);
    const resolved = tryCandidate(candidateBase);
    if (resolved) return resolved;
  }

  // 2. tsconfig/jsconfig paths
  const tsConfig = loadTsConfigPaths(workspaceRoot);
  if (tsConfig?.paths) {
    const base = tsConfig.baseUrl || workspaceRoot;
    for (const [pattern, targets] of Object.entries(tsConfig.paths)) {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1);
        if (cleanSpec.startsWith(prefix)) {
          const sub = cleanSpec.slice(prefix.length);
          for (const target of targets) {
            const targetPrefix = target.replace(/\*$/, '');
            const candidate = tryCandidate(resolve(base, targetPrefix + sub));
            if (candidate) return candidate;
          }
        }
      } else if (pattern === cleanSpec) {
        for (const target of targets) {
          const candidate = tryCandidate(resolve(base, target));
          if (candidate) return candidate;
        }
      }
    }
  }

  // 3. Fallback standard alias imports (@/ or ~/)
  if (cleanSpec.startsWith('@/') || cleanSpec.startsWith('~/')) {
    const sub = cleanSpec.slice(2);
    const srcRoots = [
      join(workspaceRoot, 'src', sub),
      join(workspaceRoot, 'app', sub),
      join(workspaceRoot, 'resources', 'js', sub),
      join(workspaceRoot, sub),
    ];
    for (const base of srcRoots) {
      const candidate = tryCandidate(base);
      if (candidate) return candidate;
    }
  }

  return null;
}

export interface TargetSymbolResult {
  startLine: number;
  endLine: number;
  lineCount: number;
  actualFilePath?: string;
}

/**
 * Fast AST line locator for a target symbol in an external file.
 * Traverses barrel re-exports (export { x } from ... and export * from ...) up to 3 hops.
 */
async function locateTargetSymbolLines(
  targetFilePath: string,
  symbolName: string,
  workspaceRoot: string,
  visited: Set<string> = new Set(),
  depth: number = 0
): Promise<TargetSymbolResult | null> {
  if (depth > 3 || visited.has(targetFilePath)) return null;
  visited.add(targetFilePath);

  try {
    const content = await fs.readFile(targetFilePath, 'utf8');
    const adapter = createDocumentAdapter(targetFilePath, content);
    const scriptBlocks = adapter.getScriptBlocks();
    const isJsx = targetFilePath.endsWith('.tsx') || targetFilePath.endsWith('.jsx');

    const pendingReExports: Array<{ targetModule: string; lookupName: string }> = [];

    for (const block of scriptBlocks) {
      const sourceFile = ts.createSourceFile(
        targetFilePath,
        block.content,
        ts.ScriptTarget.Latest,
        true,
        isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      let foundRange: TargetSymbolResult | null = null;

      function visit(node: ts.Node) {
        if (foundRange) return;

        let matched = false;
        if (ts.isFunctionDeclaration(node) && node.name?.text === symbolName) {
          matched = true;
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
              matched = true;
              break;
            }
          }
        } else if (ts.isClassDeclaration(node) && node.name?.text === symbolName) {
          matched = true;
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const modSpec = node.moduleSpecifier.text;
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              if (el.name.text === symbolName) {
                const originalName = el.propertyName ? el.propertyName.text : el.name.text;
                pendingReExports.push({ targetModule: modSpec, lookupName: originalName });
              }
            }
          } else if (!node.exportClause) {
            // export * from './mod'
            pendingReExports.push({ targetModule: modSpec, lookupName: symbolName });
          }
        }

        if (matched) {
          const tsStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const tsEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const remappedStart = remapPosition(tsStart.line + 1, tsStart.character + 1, block.loc.start);
          const remappedEnd = remapPosition(tsEnd.line + 1, tsEnd.character + 1, block.loc.start);
          const startLine = Math.max(1, remappedStart.line);
          const endLine = Math.max(startLine, remappedEnd.line);
          foundRange = {
            startLine,
            endLine,
            lineCount: Math.max(1, endLine - startLine + 1),
            actualFilePath: targetFilePath,
          };
          return;
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      if (foundRange) return foundRange;
    }

    // Follow barrel / re-export chains
    for (const reExport of pendingReExports) {
      const resolvedReExport = resolveModuleFilePath(targetFilePath, reExport.targetModule, workspaceRoot);
      if (resolvedReExport && existsSync(resolvedReExport)) {
        const reExportResult = await locateTargetSymbolLines(
          resolvedReExport,
          reExport.lookupName,
          workspaceRoot,
          visited,
          depth + 1
        );
        if (reExportResult) return reExportResult;
      }
    }
  } catch {
    // Graceful fallback if target cannot be parsed
  }
  return null;
}

/**
 * Extracts a complete outline of all declared functions and methods in a component file,
 * with exact start/end line bounds, 1-hop cross-file callee resolution, and complexity smell detection.
 */
export async function extractComponentOutline(
  filePath: string,
  options: ExtractOutlineOptions = { path: filePath }
): Promise<ComponentSymbolOutline> {
  const targetFile = resolve(filePath);
  const fileContent = await fs.readFile(targetFile, 'utf8');
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
      if (node.modifiers) {
        for (const mod of node.modifiers) {
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
  if (shouldResolveCalls) {
    const resolvedCache = new Map<string, ResolvedCalleeReference>();

    for (const fn of functions) {
      const resolvedCalls: ResolvedCalleeReference[] = [];

      for (const call of fn.internalCalls) {
        let importInfo = importedSymbols.get(call);
        let targetLookupName = call;

        // Support namespace member calls like formatters.currency
        if (!importInfo && call.includes('.')) {
          const [nsPrefix, memberName] = call.split('.', 2);
          const nsInfo = importedSymbols.get(nsPrefix);
          if (nsInfo && nsInfo.importedName === '*') {
            importInfo = nsInfo;
            targetLookupName = memberName;
          }
        }

        if (!importInfo) continue;

        const cacheKey = `${importInfo.sourceModule}::${targetLookupName}`;
        if (resolvedCache.has(cacheKey)) {
          resolvedCalls.push(resolvedCache.get(cacheKey)!);
          continue;
        }

        const targetFilePath = resolveModuleFilePath(targetFile, importInfo.sourceModule, workspaceRoot);
        const ref: ResolvedCalleeReference = {
          symbol: call,
          sourceModule: importInfo.sourceModule,
          targetFilePath: targetFilePath || undefined,
          isResolved: Boolean(targetFilePath),
        };

        if (targetFilePath && existsSync(targetFilePath)) {
          const lookupName = importInfo.importedName === '*' ? targetLookupName : importInfo.importedName;
          const lines = await locateTargetSymbolLines(targetFilePath, lookupName, workspaceRoot);
          if (lines) {
            ref.targetRange = {
              startLine: lines.startLine,
              endLine: lines.endLine,
              lineCount: lines.lineCount,
            };
            if (lines.actualFilePath) {
              ref.targetFilePath = lines.actualFilePath;
            }
          }
        }

        resolvedCache.set(cacheKey, ref);
        resolvedCalls.push(ref);
      }

      if (resolvedCalls.length > 0) {
        fn.resolvedCalls = resolvedCalls;
      }
    }
  }

  const highComplexityCount = functions.filter((f) => f.complexitySmell?.isHighComplexity).length;

  return {
    filePath: targetFile,
    framework,
    totalFunctions: functions.length,
    highComplexityCount,
    functions,
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
