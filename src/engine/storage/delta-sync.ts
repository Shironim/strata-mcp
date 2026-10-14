import { readSourceFile } from '../source-file';
import { parseVueSource } from '../vue-parser';
import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import { basename, extname, normalize, resolve, sep } from 'node:path';
import { collectFiles } from '../collector';
import {
  detectFramework,
  extractComponentContract,
  extractRenderBoundary,
  extractStateDependencies,
} from '../contract';
import {
  extractLocalImports,
  isPageFile,
  extractPassedProps,
  extractComponentContextNodes,
  resolveImportPath,
  resolveBarrelExport,
} from '../tree';
import { loadAliasConfig } from '../resolver';
import { canonicalizePath } from '../path-resolver';
import { getCandidateNames } from '../template';
import { scanRoutes } from '../routes';
import {
  getWorkspaceDatabase,
  isLayoutFile,
  SUPPORTED_EXTENSIONS,
} from './schema';
import type {
  ComponentContract,
  EdgePayload,
  StateDependencyInfo,
  SyncStats,
} from '../../types';

export interface WorkspaceDelta {
  diskMap: Map<string, { fullPath: string; mtime: number; size: number }>;
  dbMap: Map<string, { id: number; mtime: number; size: number }>;
  added: string[];
  modified: string[];
  deleted: number[];
  unchanged: number;
}

export interface ParsedFilePayload {
  path: string;
  framework: string;
  boundary: { boundary: string; directive?: string };
  stateDeps: StateDependencyInfo;
  compName: string;
  contract: ComponentContract | null;
  edges: Array<{ targetPath: string; isDynamic: boolean; payload?: EdgePayload }>;
}

export interface ParsedWorkspaceBatch {
  files: Map<string, ParsedFilePayload>;
  routes: Awaited<ReturnType<typeof scanRoutes>> | null;
}

/**
 * 1. Gathers disk candidate files and calculates the delta against SQLite.
 */
export async function hashChecker(
  absRoot: string,
  db: Database,
  scopePath?: string
): Promise<WorkspaceDelta> {
  const scanTarget = scopePath ? resolve(absRoot, scopePath) : absRoot;
  const allDiskFiles = await collectFiles(scanTarget, { ignoreRoot: absRoot });
  const candidateFiles = allDiskFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    const norm = f.replace(/\\/g, '/');
    return (
      SUPPORTED_EXTENSIONS.has(ext) &&
      !norm.includes('/.strata/') &&
      !norm.includes('/.vue-ast/') &&
      !norm.includes('/node_modules/') &&
      !norm.includes('/vendor/') &&
      !norm.includes('/dist/') &&
      !norm.includes('/public/build/') &&
      !norm.includes('/.git/')
    );
  });

  const diskMap = new Map<string, { fullPath: string; mtime: number; size: number }>();
  for (const f of candidateFiles) {
    try {
      const st = await fs.stat(f);
      const norm = normalize(f);
      diskMap.set(norm, {
        fullPath: f,
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
      });
    } catch {
      // ignore unreadable
    }
  }

  const dbFiles = db.query('SELECT id, path, mtime, size FROM files').all() as Array<{
    id: number;
    path: string;
    mtime: number;
    size: number;
  }>;

  const dbMap = new Map<string, { id: number; mtime: number; size: number }>();
  for (const row of dbFiles) {
    dbMap.set(row.path, { id: row.id, mtime: row.mtime, size: row.size });
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: number[] = [];
  let unchanged = 0;

  for (const [path, diskInfo] of diskMap.entries()) {
    const inDb = dbMap.get(path);
    if (!inDb) {
      added.push(path);
    } else if (inDb.mtime !== diskInfo.mtime || inDb.size !== diskInfo.size) {
      modified.push(path);
    } else {
      unchanged++;
    }
  }

  const normScanTarget = normalize(scanTarget);
  for (const [path, dbInfo] of dbMap.entries()) {
    // If scopePath is provided, only mark deletion for files residing within scopePath
    if (scopePath && path !== normScanTarget && !path.startsWith(normScanTarget + sep)) {
      continue;
    }
    if (!diskMap.has(path)) {
      deleted.push(dbInfo.id);
    }
  }

  return {
    diskMap,
    dbMap,
    added,
    modified,
    deleted,
    unchanged,
  };
}

/**
 * 2. Parses changed/added files in-memory for contracts, boundaries, state dependencies, and edges.
 */
export async function batchParser(
  toProcess: string[],
  absRoot: string,
  _diskMap: Map<string, { fullPath: string; mtime: number; size: number }>,
  includeRoutes = true
): Promise<ParsedWorkspaceBatch> {
  const parsedFiles = new Map<string, ParsedFilePayload>();

  for (const path of toProcess) {
    try {
      const content = await readSourceFile(path);
      if (extname(path) === '.vue') {
        const { errors } = parseVueSource(content, { filename: path, sourceMap: false });
        if (errors.length) throw new Error(`PARSE_FAILED: ${path}: ${errors.map(error => typeof error === 'string' ? error : error.message).join('; ')}`);
      }
      const framework = detectFramework(path, content);
      const boundary = extractRenderBoundary(path, content, framework);
      const stateDeps = extractStateDependencies(content, framework);
      const compName = basename(path, extname(path));
      const contract = await extractComponentContract(path, content);
      const aliasConfig = await loadAliasConfig(path);
      const allImports = extractLocalImports(content, aliasConfig);
      const { providers, consumers } = extractComponentContextNodes(path, content);

      const edges: Array<{ targetPath: string; isDynamic: boolean; payload?: EdgePayload }> = [];
      for (const imp of allImports) {
        let matchedPath = resolveImportPath(path, imp.source, aliasConfig);
        if (matchedPath && /[/\\]index\.[tj]sx?$/.test(matchedPath)) {
          matchedPath = resolveBarrelExport(matchedPath, imp.name, aliasConfig) ?? matchedPath;
        }
        if (matchedPath) matchedPath = canonicalizePath(matchedPath);

        if (matchedPath) {
          const candidateNames = getCandidateNames(imp.alias || imp.name || basename(matchedPath, extname(matchedPath)));
          const passedProps = extractPassedProps(content, candidateNames);

          edges.push({
            targetPath: matchedPath,
            isDynamic: imp.isDynamic ?? false,
            payload: {
              alias: imp.alias,
              passedProps: passedProps.length > 0 ? passedProps : undefined,
              contexts: (providers.length > 0 || consumers.length > 0) ? {
                provided: providers.length > 0 ? providers : undefined,
                consumed: consumers.length > 0 ? consumers : undefined,
              } : undefined,
            },
          });
        }
      }

      parsedFiles.set(path, {
        path,
        framework,
        boundary,
        stateDeps,
        compName,
        contract,
        edges,
      });
    } catch (err) {
      throw new Error(`PARSE_FAILED: ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let routeManifest: Awaited<ReturnType<typeof scanRoutes>> | null = null;
  if (includeRoutes) {
    const manifest = await scanRoutes({ targetPath: absRoot });
    routeManifest = manifest;
  }

  return {
    files: parsedFiles,
    routes: routeManifest,
  };
}

/**
 * 3. Commits file delta, parsed components, edges, state dependencies, and routes in an atomic SQLite transaction.
 */
export function transactionCommitter(
  db: Database,
  delta: WorkspaceDelta,
  parsedBatch: ParsedWorkspaceBatch,
  startTime: number
): SyncStats {
  const insertFileStmt = db.prepare(`
    INSERT INTO files (path, framework, mtime, size, is_page, is_layout, render_boundary, boundary_directive)
    VALUES ($path, $framework, $mtime, $size, $is_page, $is_layout, $render_boundary, $boundary_directive)
    RETURNING id;
  `);

  const updateFileStmt = db.prepare(`
    UPDATE files
    SET framework = $framework, mtime = $mtime, size = $size, is_page = $is_page,
        is_layout = $is_layout, render_boundary = $render_boundary, boundary_directive = $boundary_directive
    WHERE id = $id;
  `);

  const insertComponentStmt = db.prepare(`
    INSERT OR REPLACE INTO components (file_id, name, contract_json)
    VALUES ($file_id, $name, $contract_json);
  `);

  const insertEdgeStmt = db.prepare(`
    INSERT OR IGNORE INTO edges (parent_file_id, child_file_id, import_type, is_rendered, payload_json)
    VALUES ($parent_file_id, $child_file_id, $import_type, $is_rendered, $payload_json);
  `);

  const insertStateDepStmt = db.prepare(`
    INSERT INTO state_deps (file_id, kind, identifier, access_mode, line_number, usage_snippet)
    VALUES ($file_id, $kind, $identifier, $access_mode, $line_number, $usage_snippet);
  `);

  const deleteFileStmt = db.prepare(`DELETE FROM files WHERE id = ?;`);
  const deleteComponentsStmt = db.prepare(`DELETE FROM components WHERE file_id = $id;`);
  const deleteEdgesStmt = db.prepare(`DELETE FROM edges WHERE parent_file_id = $id;`);
  const deleteStateDepsStmt = db.prepare(`DELETE FROM state_deps WHERE file_id = $id;`);

  const toProcess = [...delta.added, ...delta.modified];
  const modifiedSet = new Set(delta.modified);
  const deletedSet = new Set(delta.deleted);
  const fileIdMap = new Map<string, number>();

  for (const [path, info] of delta.dbMap.entries()) {
    if (!deletedSet.has(info.id)) fileIdMap.set(path, info.id);
  }

  const transaction = db.transaction(() => {
    // A. Delete vanished files
    for (const delId of delta.deleted) {
      deleteFileStmt.run(delId);
    }

    // B. Process added and modified files
    for (const path of toProcess) {
      const diskInfo = delta.diskMap.get(path);
      if (!diskInfo) continue;

      const parsed = parsedBatch.files.get(path);
      const framework = parsed?.framework || detectFramework(path);
      const isPage = isPageFile(path) ? 1 : 0;
      const isLayout = isLayoutFile(path) ? 1 : 0;
      const renderBoundary = parsed?.boundary.boundary || null;
      const boundaryDirective = parsed?.boundary.directive || null;

      let fileId: number;
      if (modifiedSet.has(path) && delta.dbMap.has(path)) {
        fileId = delta.dbMap.get(path)!.id;
        updateFileStmt.run({
          $id: fileId,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: renderBoundary,
          $boundary_directive: boundaryDirective,
        });
        deleteComponentsStmt.run({ $id: fileId });
        deleteEdgesStmt.run({ $id: fileId });
        deleteStateDepsStmt.run({ $id: fileId });
      } else {
        const res = insertFileStmt.get({
          $path: path,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: renderBoundary,
          $boundary_directive: boundaryDirective,
        }) as { id: number };
        fileId = res.id;
      }

      fileIdMap.set(path, fileId);
    }

    // C. Insert parsed components, state deps, and edges
    for (const parsed of parsedBatch.files.values()) {
      const fileId = fileIdMap.get(parsed.path);
      if (!fileId) continue;

      insertComponentStmt.run({
        $file_id: fileId,
        $name: parsed.compName,
        $contract_json: JSON.stringify(parsed.contract),
      });

      if (parsed.stateDeps.items && parsed.stateDeps.items.length > 0) {
        for (const item of parsed.stateDeps.items) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: item.kind,
            $identifier: item.identifier,
            $access_mode: item.accessMode,
            $line_number: item.lineNumber ?? 0,
            $usage_snippet: item.usageSnippet ?? null,
          });
        }
      } else {
        for (const st of parsed.stateDeps.stores) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'store',
            $identifier: st,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
        for (const ctx of parsed.stateDeps.contexts) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'context',
            $identifier: ctx,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
        for (const cmp of parsed.stateDeps.composables) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'composable',
            $identifier: cmp,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
      }

      for (const edge of parsed.edges) {
        const childId = fileIdMap.get(edge.targetPath);
        if (childId) {
          insertEdgeStmt.run({
            $parent_file_id: fileId,
            $child_file_id: childId,
            $import_type: edge.isDynamic ? 'dynamic' : 'static',
            $is_rendered: 1,
            $payload_json: edge.payload ? JSON.stringify(edge.payload) : null,
          });
        }
      }
    }

    // D. Sync routes table
    if (parsedBatch.routes) {
      db.run('DELETE FROM routes;');
      if (parsedBatch.routes.routes && parsedBatch.routes.routes.length > 0) {
        const insertRouteStmt = db.prepare(`
          INSERT OR REPLACE INTO routes (url_path, file_id, type, params_json, handlers_json, layout_chain_json)
          VALUES ($url_path, $file_id, $type, $params_json, $handlers_json, $layout_chain_json);
        `);

        for (const r of parsedBatch.routes.routes) {
          const fId = fileIdMap.get(normalize(r.filePath));
          if (fId) {
            insertRouteStmt.run({
              $url_path: r.path,
              $file_id: fId,
              $type: r.type,
              $params_json: JSON.stringify(r.params),
              $handlers_json: r.handlers ? JSON.stringify(r.handlers) : null,
              $layout_chain_json: r.layouts ? JSON.stringify(r.layouts) : null,
            });
          }
        }
      }
    }
  });

  transaction();

  return {
    added: delta.added.length,
    modified: delta.modified.length,
    deleted: delta.deleted.length,
    unchanged: delta.unchanged,
    total: delta.diskMap.size,
    durationMs: Math.round(performance.now() - startTime),
  };
}

/**
 * Synchronizes the workspace disk state with SQLite using file mtime (Smart Delta Sync).
 * Orchestrates: hashChecker -> batchParser -> transactionCommitter.
 */
export async function syncWorkspace(
  workspaceRoot: string,
  scopePath?: string,
  database?: Database
): Promise<SyncStats> {
  const absRoot = canonicalizePath(workspaceRoot);
  const db = database ?? getWorkspaceDatabase(absRoot);
  const previous = syncQueues.get(db) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const { stagedSync } = await import('./staged-sync');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await stagedSync(absRoot, scopePath, db); }
      catch (err) {
        if (attempt || !(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) throw err;
      }
    }
    throw new Error('WORKSPACE_CHANGED: retries exhausted');
  });
  syncQueues.set(db, operation);
  try { return await operation; }
  finally { if (syncQueues.get(db) === operation) syncQueues.delete(db); }
}

const syncQueues = new WeakMap<Database, Promise<unknown>>();
