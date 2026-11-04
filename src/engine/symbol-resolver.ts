import * as ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { canonicalizePath } from './path-resolver';
import { readSourceFile } from './source-file';
import { loadTsConfigHierarchySync } from './resolver';
import type { ResolvedCalleeReference } from '../types';

export interface TsConfigPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

export interface TargetSymbolResult {
  startLine: number;
  endLine: number;
  lineCount: number;
  actualFilePath?: string;
}

export interface ImportedSymbolInfo {
  importedName: string;
  sourceModule: string;
}

/**
 * Clears the cached tsconfig paths mapping.
 */
export function clearTsConfigCache(): void {
  // Kept for callers; compiler configuration is read fresh for each operation.
}

/**
 * Loads and caches compilerOptions.paths from tsconfig.json or jsconfig.json.
 */
export function loadTsConfigPaths(workspaceRoot: string): TsConfigPaths | null {
  const candidateFiles = ['tsconfig.json', 'jsconfig.json'];
  for (const configFile of candidateFiles) {
    const fullPath = join(workspaceRoot, configFile);
    if (existsSync(fullPath)) {
      try {
        const hierarchy = loadTsConfigHierarchySync(fullPath);
        if (Object.keys(hierarchy.paths).length > 0) {
          return {
            baseUrl: workspaceRoot,
            paths: hierarchy.paths,
          };
        }
      } catch {
        // Graceful fallback
      }
    }
  }
  return null;
}

/**
 * Resolves an imported module specifier to an absolute file path.
 * Supports relative paths, tsconfig/jsconfig paths mapping, and standard fallback aliases (@/, ~/).
 */
export function resolveModuleFilePath(
  currentFile: string,
  moduleSpecifier: string,
  workspaceRoot: string
): string | null {
  const cleanSpec = moduleSpecifier.trim().replace(/^['"]|['"]$/g, '');
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.svelte', '.astro'];

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

/**
 * Fast AST line locator for a target symbol in an external file.
 * Traverses barrel re-exports (export { x } from ... and export * from ...) up to 3 hops.
 */
export async function locateTargetSymbolLines(
  targetFilePath: string,
  symbolName: string,
  workspaceRoot: string,
  visited: Set<string> = new Set(),
  depth: number = 0,
  trackedDeps?: Map<string, string>
): Promise<TargetSymbolResult | null> {
  if (depth > 3 || visited.has(targetFilePath)) return null;
  visited.add(targetFilePath);

  try {
    const content = await readSourceFile(targetFilePath);
    if (trackedDeps) {
      const h = createHash('sha256').update(content).digest('hex');
      trackedDeps.set(canonicalizePath(targetFilePath), h);
    }
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
          depth + 1,
          trackedDeps
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
 * Extracts imported symbols from a file's script blocks.
 */
export function extractImportedSymbols(
  filePath: string,
  content: string
): Map<string, ImportedSymbolInfo> {
  const map = new Map<string, ImportedSymbolInfo>();
  const adapter = createDocumentAdapter(filePath, content);
  const scriptBlocks = adapter.getScriptBlocks();
  const ext = extname(filePath).toLowerCase();
  const isJsx = ext === '.tsx' || ext === '.jsx' || adapter.isJsx();

  for (const block of scriptBlocks) {
    const sourceFile = ts.createSourceFile(
      filePath,
      block.content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const moduleSpecifier = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        if (clause) {
          if (clause.name) {
            map.set(clause.name.text, {
              importedName: clause.name.text,
              sourceModule: moduleSpecifier,
            });
          }
          if (clause.namedBindings) {
            if (ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                map.set(el.name.text, {
                  importedName: el.propertyName ? el.propertyName.text : el.name.text,
                  sourceModule: moduleSpecifier,
                });
              }
            } else if (ts.isNamespaceImport(clause.namedBindings)) {
              map.set(clause.namedBindings.name.text, {
                importedName: '*',
                sourceModule: moduleSpecifier,
              });
            }
          }
        }
      }
    }
  }

  return map;
}

/**
 * Resolves 1-hop cross-file callees for given call symbols.
 */
export async function resolveCalleesForCalls(
  calls: string[],
  targetFile: string,
  importedSymbols: Map<string, ImportedSymbolInfo>,
  workspaceRoot: string,
  resolvedCache?: Map<string, ResolvedCalleeReference>,
  trackedDeps?: Map<string, string>
): Promise<ResolvedCalleeReference[]> {
  const cache = resolvedCache || new Map<string, ResolvedCalleeReference>();
  const resolvedCalls: ResolvedCalleeReference[] = [];

  for (const call of calls) {
    let importInfo = importedSymbols.get(call);
    let targetLookupName = call;

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
    if (cache.has(cacheKey)) {
      resolvedCalls.push(cache.get(cacheKey)!);
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
      const lines = await locateTargetSymbolLines(targetFilePath, lookupName, workspaceRoot, new Set(), 0, trackedDeps);
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

    cache.set(cacheKey, ref);
    resolvedCalls.push(ref);
  }

  return resolvedCalls;
}
