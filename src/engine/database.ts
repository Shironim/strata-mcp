import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import {
  detectFramework,
  extractComponentContract,
  extractRenderBoundary,
  extractStateDependencies,
} from './contract';
import { extractLocalImports, isPageFile } from './tree';
import { scanRoutes } from './routes';
import type {
  QueryStateImpactOptions,
  StateImpactConsumer,
  StateImpactResult,
  SyncStats,
} from '../types';

const SUPPORTED_EXTENSIONS = new Set(['.vue', '.astro', '.tsx', '.jsx', '.ts', '.js']);

/**
 * Checks if a file path represents a layout file.
 */
export function isLayoutFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(norm).toLowerCase();
  return (
    base.startsWith('layout.') ||
    norm.includes('/layouts/') ||
    norm.includes('/Layouts/') ||
    base.includes('layout')
  );
}

/**
 * Opens or initializes a SQLite database for the workspace with WAL mode.
 */
export function getWorkspaceDatabase(workspaceRoot: string): Database {
  const absRoot = resolve(workspaceRoot);
  const dbDir = join(absRoot, '.vue-ast');

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    // Write a .gitignore inside .vue-ast so cache DB is never checked into Git
    try {
      writeFileSync(join(dbDir, '.gitignore'), '*\n');
    } catch {
      // ignore
    }
  }

  const dbPath = join(dbDir, 'graph.db');
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode & foreign keys for high-concurrency performance
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');

  initSchema(db);
  return db;
}

/**
 * Initializes table schemas and indexes if they do not exist.
 */
function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      framework TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      is_page INTEGER DEFAULT 0,
      is_layout INTEGER DEFAULT 0,
      render_boundary TEXT,
      boundary_directive TEXT
    );

    CREATE TABLE IF NOT EXISTS components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      contract_json TEXT,
      UNIQUE(file_id, name)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      child_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      import_type TEXT NOT NULL,
      is_rendered INTEGER DEFAULT 1,
      UNIQUE(parent_file_id, child_file_id, import_type)
    );

    CREATE TABLE IF NOT EXISTS state_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      identifier TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_path TEXT UNIQUE NOT NULL,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      params_json TEXT,
      handlers_json TEXT,
      layout_chain_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
    CREATE INDEX IF NOT EXISTS idx_edges_parent ON edges(parent_file_id);
    CREATE INDEX IF NOT EXISTS idx_edges_child ON edges(child_file_id);
    CREATE INDEX IF NOT EXISTS idx_state_deps_identifier ON state_deps(identifier);
    CREATE INDEX IF NOT EXISTS idx_routes_url ON routes(url_path);
  `);
}

/**
 * Synchronizes the workspace disk state with SQLite using file mtime (Smart Delta Sync).
 */
export async function syncWorkspace(workspaceRoot: string): Promise<SyncStats> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  const db = getWorkspaceDatabase(absRoot);

  // 1. Gather all project files from disk
  const allDiskFiles = await collectFiles(absRoot);
  const candidateFiles = allDiskFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    const norm = f.replace(/\\/g, '/');
    return (
      SUPPORTED_EXTENSIONS.has(ext) &&
      !norm.includes('/.vue-ast/') &&
      !norm.includes('/node_modules/') &&
      !norm.includes('/vendor/') &&
      !norm.includes('/dist/') &&
      !norm.includes('/public/build/') &&
      !norm.includes('/.git/')
    );
  });

  // Map of normalized path -> disk stat
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

  // 2. Query all known files from SQLite
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

  // 3. Compute Delta
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

  for (const [path, dbInfo] of dbMap.entries()) {
    if (!diskMap.has(path)) {
      deleted.push(dbInfo.id);
    }
  }

  // If nothing changed, fast return!
  if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
    return {
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged,
      total: diskMap.size,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  // 4. Apply Delta within a transaction
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
    INSERT OR IGNORE INTO edges (parent_file_id, child_file_id, import_type, is_rendered)
    VALUES ($parent_file_id, $child_file_id, $import_type, $is_rendered);
  `);

  const insertStateDepStmt = db.prepare(`
    INSERT INTO state_deps (file_id, kind, identifier)
    VALUES ($file_id, $kind, $identifier);
  `);

  const deleteFileStmt = db.prepare(`DELETE FROM files WHERE id = ?;`);
  const cleanRelationsStmt = db.prepare(`
    DELETE FROM components WHERE file_id = $id;
    DELETE FROM edges WHERE parent_file_id = $id;
    DELETE FROM state_deps WHERE file_id = $id;
  `);

  const toProcess = [...added, ...modified];
  const fileIdMap = new Map<string, number>();

  // Populate existing file IDs
  for (const [path, info] of dbMap.entries()) {
    fileIdMap.set(path, info.id);
  }

  const transaction = db.transaction(() => {
    // A. Delete vanished files
    for (const delId of deleted) {
      deleteFileStmt.run(delId);
    }

    // B. Process added and modified files
    for (const path of toProcess) {
      const diskInfo = diskMap.get(path);
      if (!diskInfo) continue;

      const framework = detectFramework(path);
      const isPage = isPageFile(path) ? 1 : 0;
      const isLayout = isLayoutFile(path) ? 1 : 0;

      let fileId: number;
      if (modified.includes(path) && dbMap.has(path)) {
        fileId = dbMap.get(path)!.id;
        updateFileStmt.run({
          $id: fileId,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: null,
          $boundary_directive: null,
        });
        cleanRelationsStmt.run({ $id: fileId });
      } else {
        const res = insertFileStmt.get({
          $path: path,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: null,
          $boundary_directive: null,
        }) as { id: number };
        fileId = res.id;
      }

      fileIdMap.set(path, fileId);
    }
  });

  transaction();

  // 5. Asynchronously parse contents for components, state deps, boundaries, and edges
  for (const path of toProcess) {
    const fileId = fileIdMap.get(path);
    if (!fileId) continue;

    try {
      const content = await fs.readFile(path, 'utf8');
      const framework = detectFramework(path);

      // Boundaries & State
      const boundary = extractRenderBoundary(path, content, framework);
      const stateDeps = extractStateDependencies(content, framework);

      // Update boundary in file record
      db.prepare(
        'UPDATE files SET render_boundary = ?, boundary_directive = ? WHERE id = ?'
      ).run(boundary.boundary, boundary.directive || null, fileId);

      // Components
      const compName = basename(path, extname(path));
      const contract = await extractComponentContract(path, content);
      insertComponentStmt.run({
        $file_id: fileId,
        $name: compName,
        $contract_json: JSON.stringify(contract),
      });

      // State Dependencies
      for (const st of stateDeps.stores) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'store', $identifier: st });
      }
      for (const ctx of stateDeps.contexts) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'context', $identifier: ctx });
      }
      for (const cmp of stateDeps.composables) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'composable', $identifier: cmp });
      }

      // Static & Dynamic Imports (Edges)
      const allImports = extractLocalImports(content);

      for (const imp of allImports) {
        // Resolve relative import
        if (imp.source.startsWith('.')) {
          const targetCandidate = resolve(dirname(path), imp.source);
          let matchedPath: string | undefined;

          // Try common extensions
          for (const ext of ['', '.vue', '.tsx', '.jsx', '.ts', '.js', '/index.ts', '/index.vue']) {
            const testP = normalize(targetCandidate + ext);
            if (diskMap.has(testP)) {
              matchedPath = testP;
              break;
            }
          }

          if (matchedPath && fileIdMap.has(matchedPath)) {
            const childId = fileIdMap.get(matchedPath)!;
            insertEdgeStmt.run({
              $parent_file_id: fileId,
              $child_file_id: childId,
              $import_type: imp.isDynamic ? 'dynamic' : 'static',
              $is_rendered: 1,
            });
          }
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  // 6. Sync routes table if routes exist
  try {
    const routeManifest = await scanRoutes({ targetPath: absRoot });
    if (routeManifest.routes.length > 0) {
      db.run('DELETE FROM routes;');
      const insertRouteStmt = db.prepare(`
        INSERT OR REPLACE INTO routes (url_path, file_id, type, params_json, handlers_json, layout_chain_json)
        VALUES ($url_path, $file_id, $type, $params_json, $handlers_json, $layout_chain_json);
      `);

      for (const r of routeManifest.routes) {
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
  } catch {
    // ignore route scan failures
  }

  return {
    added: added.length,
    modified: modified.length,
    deleted: deleted.length,
    unchanged,
    total: diskMap.size,
    durationMs: Math.round(performance.now() - startTime),
  };
}

/**
 * Queries the impact of a state dependency (store, context, composable) across all files in SQLite.
 */
export async function queryStateImpact(
  workspaceRoot: string,
  identifier: string
): Promise<StateImpactResult> {
  const absRoot = resolve(workspaceRoot);
  await syncWorkspace(absRoot);
  const db = getWorkspaceDatabase(absRoot);

  const rows = db
    .query(
      `
    SELECT DISTINCT f.path, f.is_page, f.render_boundary, s.kind, s.identifier
    FROM state_deps s
    JOIN files f ON s.file_id = f.id
    WHERE s.identifier = ?
    ORDER BY f.is_page DESC, f.path ASC;
  `
    )
    .all(identifier) as Array<{
    path: string;
    is_page: number;
    render_boundary: string | null;
    kind: 'store' | 'context' | 'composable';
    identifier: string;
  }>;

  const consumers: StateImpactConsumer[] = rows.map((r) => ({
    path: r.path,
    isPage: r.is_page === 1,
    renderBoundary: r.render_boundary || undefined,
    kind: r.kind,
    identifier: r.identifier,
  }));

  return {
    identifier,
    totalConsumers: consumers.length,
    consumers,
  };
}

/**
 * Formats a StateImpactResult into a token-efficient human-readable summary.
 */
export function formatStateImpactAsText(result: StateImpactResult): string {
  const lines: string[] = [
    `State Impact Analysis for: ${result.identifier}`,
    `Total Dependent Components/Pages: ${result.totalConsumers}`,
  ];

  if (result.totalConsumers === 0) {
    lines.push('\n(No dependent files found for this state identifier)');
    return lines.join('\n');
  }

  lines.push('\nConsumers:');
  for (const c of result.consumers) {
    const pageBadge = c.isPage ? ' [Page]' : '';
    const boundaryBadge = c.renderBoundary ? ` (${c.renderBoundary})` : '';
    lines.push(`  - ${c.path}${pageBadge}${boundaryBadge}`);
  }

  return lines.join('\n');
}

export interface UpwardBlastRadiusNode {
  path: string;
  framework: string;
  isPage: boolean;
  depth: number;
}

/**
 * Queries the upward blast radius (consumers up to pages) using SQLite Recursive CTE.
 */
export function queryUpwardBlastRadiusFromDb(
  db: Database,
  targetPath: string,
  maxDepth: number = 5
): UpwardBlastRadiusNode[] {
  const normTarget = normalize(targetPath);
  const target = db
    .query('SELECT id FROM files WHERE path = ?')
    .get(normTarget) as { id: number } | null;
  if (!target) return [];

  const rows = db
    .query(
      `
    WITH RECURSIVE blast_radius(file_id, depth) AS (
      SELECT parent_file_id, 1 FROM edges WHERE child_file_id = ?
      UNION
      SELECT e.parent_file_id, b.depth + 1
      FROM edges e JOIN blast_radius b ON e.child_file_id = b.file_id
      WHERE b.depth < ?
    )
    SELECT DISTINCT f.path, f.framework, f.is_page, b.depth
    FROM blast_radius b
    JOIN files f ON b.file_id = f.id
    ORDER BY b.depth ASC, f.is_page DESC;
  `
    )
    .all(target.id, maxDepth) as Array<{
    path: string;
    framework: string;
    is_page: number;
    depth: number;
  }>;

  return rows.map((r) => ({
    path: r.path,
    framework: r.framework,
    isPage: r.is_page === 1,
    depth: r.depth,
  }));
}

/**
 * Queries unused/orphan components directly using an SQL anti-join.
 */
export function queryUnusedComponentsFromDb(
  db: Database
): Array<{ name: string; path: string; framework: string }> {
  const rows = db
    .query(
      `
    SELECT c.name, f.path, f.framework
    FROM components c
    JOIN files f ON c.file_id = f.id
    LEFT JOIN edges e ON c.file_id = e.child_file_id
    WHERE e.child_file_id IS NULL AND f.is_page = 0 AND f.is_layout = 0
    ORDER BY c.name ASC;
  `
    )
    .all() as Array<{ name: string; path: string; framework: string }>;

  return rows;
}

