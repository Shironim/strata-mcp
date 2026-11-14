import { readSourceFile } from '../source-file';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createDocumentAdapter } from '../../adapters/factory';
import type { StateChainNode, StateChainResult, TraceStateChainOptions } from '../../types';
import { prepareStateQuery } from './state-query';
import { canonicalizePath } from '../path-resolver';
import { isSameMonorepoBoundary } from '../graph/path-helpers';

/**
 * Traces the multi-hop dependency chain of a composable or store (both consumers and internal dependencies).
 */
export async function traceStateChain(
  workspaceRoot: string,
  options: TraceStateChainOptions & { skipSync?: boolean }
): Promise<StateChainResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  const scopeRoot = canonicalizePath(absRoot);
  const inRequestedScope = (filePath: string): boolean => {
    const norm = canonicalizePath(filePath);
    return norm === scopeRoot || norm.startsWith(`${scopeRoot}/`);
  };
  const { db, sync } = await prepareStateQuery(absRoot, options?.skipSync);

  const identifier = options.identifier;
  const maxDepth = options.maxDepth || 3;
  const direction = options.direction || 'both';

  const consumers: StateChainNode[] = [];
  const dependencies: StateChainNode[] = [];
  const roleFilter = options.role || 'all';

  // Helper to check if a file actually declares/exports the identifier
  async function fileDeclaresIdentifier(filePath: string, ident: string): Promise<boolean> {
    try {
      const code = await readSourceFile(filePath);
      for (const block of createDocumentAdapter(filePath, code).getScriptBlocks()) {
        const sf = ts.createSourceFile(filePath, block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        for (const stmt of sf.statements) {
          if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === ident) return true;
          if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === ident)) return true;
          if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.some(e => !e.isTypeOnly && e.name.text === ident)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // 1. Find the declaring file:
  // Step A: Check candidate files matching identifier path
  let declaringFile: { id: number; path: string } | null = null;
  const pathCandidates = db
    .query(`
      SELECT id, path FROM files
      WHERE path LIKE '%/' || ? || '.%'
         OR path LIKE '%/' || ? || '/index.%'
         OR LOWER(path) LIKE '%/' || LOWER(?) || '.%'
         OR LOWER(path) LIKE '%/' || LOWER(?) || '/index.%'
    `)
    .all(identifier, identifier, identifier, identifier) as Array<{ id: number; path: string }>;

  for (const c of pathCandidates) {
    if (inRequestedScope(c.path) && (await fileDeclaresIdentifier(c.path, identifier))) {
      declaringFile = c;
      break;
    }
  }

  // Step B: Check files imported by consumers of identifier
  if (!declaringFile) {
    const importedByConsumers = db
      .query(`
        SELECT DISTINCT c.id, c.path FROM files c
        JOIN edges e ON e.child_file_id = c.id
        JOIN files p ON e.parent_file_id = p.id
        JOIN state_deps s ON s.file_id = p.id
        WHERE s.identifier = ?
      `)
      .all(identifier) as Array<{ id: number; path: string }>;

    for (const c of importedByConsumers) {
      if (inRequestedScope(c.path) && (await fileDeclaresIdentifier(c.path, identifier))) {
        declaringFile = c;
        break;
      }
    }
  }

  // Step C: Scan all other files in files table for explicit export of identifier
  if (!declaringFile) {
    const allFiles = db.query('SELECT id, path FROM files ORDER BY path ASC').all() as Array<{ id: number; path: string }>;
    for (const c of allFiles) {
      if (inRequestedScope(c.path) && (await fileDeclaresIdentifier(c.path, identifier))) {
        declaringFile = c;
        break;
      }
    }
  }

  // 2. Consumers (Upward): Files consuming this identifier and components consuming them
  if (direction === 'consumers' || direction === 'both') {
    const visitedConsumers = new Set<string>();
    let currentFiles: Array<{ path: string; fileId: number; depth: number }> = [];

    const directRows = db
      .query(`
        SELECT f.id, f.path, s.kind, s.access_mode
        FROM state_deps s
        JOIN files f ON s.file_id = f.id
        WHERE s.identifier = ?
      `)
      .all(identifier) as Array<{ id: number; path: string; kind: string; access_mode: string }>;

    // Aggregate by file to evaluate mutator vs reader role
    const directFileMap = new Map<string, { id: number; path: string; kind: string; isMutator: boolean }>();
    for (const r of directRows) {
      if (!inRequestedScope(r.path)) continue;
      if (declaringFile && !isSameMonorepoBoundary(declaringFile.path, r.path)) continue;
      const existing = directFileMap.get(r.path);
      const isMutator = r.access_mode === 'write';
      if (!existing) {
        directFileMap.set(r.path, { id: r.id, path: r.path, kind: r.kind, isMutator });
      } else if (isMutator) {
        existing.isMutator = true;
      }
    }

    for (const item of directFileMap.values()) {
      if (roleFilter === 'mutators' && !item.isMutator) continue;
      if (roleFilter === 'readers' && item.isMutator) continue;

      if (!visitedConsumers.has(item.path)) {
        visitedConsumers.add(item.path);
        const node: StateChainNode = {
          identifier: item.path.split(/[/\\]/).pop() || item.path,
          filePath: item.path,
          kind: item.kind as any,
          direction: 'consumer',
          depth: 1,
          role: item.isMutator ? 'mutator' : 'reader',
        };
        consumers.push(node);
        currentFiles.push({ path: item.path, fileId: item.id, depth: 1 });
      }
    }

    const parentRowsStmt = db.prepare(`
      SELECT DISTINCT f.id, f.path
      FROM edges e
      JOIN files f ON e.parent_file_id = f.id
      WHERE e.child_file_id = ?
      ORDER BY f.path ASC
    `);

    // Traverse upwards along edges: who imports these current files?
    for (let d = 2; d <= maxDepth && currentFiles.length > 0; d++) {
      const nextFiles: Array<{ path: string; fileId: number; depth: number }> = [];
      for (const curr of currentFiles) {
        const parentRows = parentRowsStmt.all(curr.fileId) as Array<{ id: number; path: string }>;

        for (const prow of parentRows) {
          if (!inRequestedScope(prow.path) || !isSameMonorepoBoundary(curr.path, prow.path)) continue;
          if (!visitedConsumers.has(prow.path)) {
            visitedConsumers.add(prow.path);
            const node: StateChainNode = {
              identifier: prow.path.split(/[/\\]/).pop() || prow.path,
              filePath: prow.path,
              kind: prow.path.endsWith('.vue') ? 'component' : 'composable',
              direction: 'consumer',
              depth: d,
            };
            consumers.push(node);
            nextFiles.push({ path: prow.path, fileId: prow.id, depth: d });
          }
        }
      }
      currentFiles = nextFiles;
    }
  }

  // 3. Dependencies (Downward): What other composables/helpers does the declaring file consume?
  if ((direction === 'dependencies' || direction === 'both') && declaringFile) {
    const visitedDeps = new Set<string>();
    let currentDepFiles: Array<{ fileId: number; depth: number }> = [{ fileId: declaringFile.id, depth: 1 }];

    const depRowsStmt = db.prepare(`
      SELECT DISTINCT s.identifier, s.kind
      FROM state_deps s
      WHERE s.file_id = ?
      ORDER BY s.identifier ASC, s.kind ASC
    `);

    const findDepFileStmt = db.prepare(`
      SELECT f.id, f.path
      FROM files f
      WHERE f.path LIKE '%/' || ? || '.%'
         OR f.path LIKE '%/' || ? || '/index.%'
         OR f.path LIKE '%' || ? || '%'
      ORDER BY
        CASE
          WHEN f.path LIKE '%/' || ? || '.%' THEN 1
          WHEN f.path LIKE '%/' || ? || '/index.%' THEN 2
          ELSE 3
        END,
        f.path ASC;
    `);

    for (let d = 1; d <= maxDepth && currentDepFiles.length > 0; d++) {
      const nextDepFiles: Array<{ fileId: number; depth: number }> = [];
      for (const curr of currentDepFiles) {
        const depRows = depRowsStmt.all(curr.fileId) as Array<{ identifier: string; kind: string }>;

        for (const drow of depRows) {
          if (drow.identifier !== identifier && !visitedDeps.has(drow.identifier)) {
            visitedDeps.add(drow.identifier);

            const depFileCandidates = findDepFileStmt.all(
              drow.identifier,
              drow.identifier,
              drow.identifier,
              drow.identifier,
              drow.identifier
            ) as Array<{ id: number; path: string }>;
            const depFileRow = depFileCandidates.find(
              (f) => inRequestedScope(f.path) && (!declaringFile || isSameMonorepoBoundary(declaringFile.path, f.path))
            ) ?? null;

            dependencies.push({
              identifier: drow.identifier,
              filePath: depFileRow ? depFileRow.path : '',
              kind: drow.kind as any,
              direction: 'dependency',
              depth: d,
            });

            if (depFileRow) {
              nextDepFiles.push({ fileId: depFileRow.id, depth: d + 1 });
            }
          }
        }
      }
      currentDepFiles = nextDepFiles;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    identifier,
    entryFile: declaringFile?.path,
    consumers,
    dependencies,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs,
      cached: sync.cacheHit,
      syncGeneration: sync.syncGeneration,
      configFingerprint: sync.configFingerprint,
    },
  };
}
