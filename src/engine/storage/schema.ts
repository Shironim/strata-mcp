import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalizePath } from '../path-resolver';

export const SUPPORTED_EXTENSIONS = new Set(['.vue', '.astro', '.svelte', '.tsx', '.jsx', '.ts', '.js']);
export const SCHEMA_USER_VERSION = 2;

/**
 * Checks if a file path represents a layout file.
 */
export function isLayoutFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(norm).toLowerCase();
  const nameWithoutExt = base.replace(/\.[^.]+$/, '');
  return (
    nameWithoutExt === 'layout' ||
    nameWithoutExt.endsWith('layout') ||
    norm.includes('/layouts/') ||
    norm.includes('/Layouts/')
  );
}

export interface WorkspaceDatabaseOptions {
  enableWatcher?: boolean;
  create?: boolean;
}

export const dbRegistry = new Map<string, Database>();

/**
 * Walks up parent directories from workspaceRoot to find an initialized .strata directory.
 */
export function resolveIndexedWorkspaceRoot(workspaceRoot: string): string | null {
  let current = canonicalizePath(workspaceRoot);
  while (true) {
    if (existsSync(join(current, '.strata'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Checks whether the workspace (or an ancestor monorepo root) has an initialized .strata database directory.
 */
export function isWorkspaceIndexed(workspaceRoot: string): boolean {
  return resolveIndexedWorkspaceRoot(workspaceRoot) !== null;
}

/**
 * Opens or initializes a SQLite database for the workspace with WAL mode.
 * Reuses existing open database instances for the same workspace.
 *
 * NOTE: If .strata directory does not exist and options.create !== true,
 * this function throws NOT_INDEXED to prevent polluting uninitialized directories.
 */
export function getWorkspaceDatabase(
  workspaceRoot: string,
  options: WorkspaceDatabaseOptions = {}
): Database {
  const requestedRoot = canonicalizePath(workspaceRoot);
  const absRoot = options.create
    ? requestedRoot
    : (resolveIndexedWorkspaceRoot(requestedRoot) ?? requestedRoot);
  const existing = dbRegistry.get(absRoot);
  if (existing) {
    return existing;
  }

  const dbDir = join(absRoot, '.strata');

  if (!existsSync(dbDir)) {
    if (!options.create) {
      throw new Error(`NOT_INDEXED: Workspace "${absRoot}" is not initialized. Run "strata init" first.`);
    }
    mkdirSync(dbDir, { recursive: true });
    // Write a .gitignore inside .strata so cache DB is never checked into Git
    try {
      writeFileSync(join(dbDir, '.gitignore'), '*\n');
    } catch {
      // ignore
    }
  }

  const dbPath = join(dbDir, 'graph.db');
  const db = new Database(dbPath, { create: true });
  try {
    // Enable WAL mode & foreign keys for high-concurrency performance
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA foreign_keys = ON;');
    db.run('PRAGMA busy_timeout = 15000;');
    db.run('PRAGMA cache_size = -8192;');
    db.run('PRAGMA temp_store = FILE;');

    initSchema(db);
  } catch (err) {
    db.close();
    const code = (err as { code?: string })?.code;
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
      throw new Error(`SQLite database may be corrupt: ${dbPath}. Back up graph.db and any graph.db-wal and graph.db-shm files before manual diagnosis.`, { cause: err });
    }
    throw err;
  }
  dbRegistry.set(absRoot, db);

  return db;
}

/**
 * Closes the SQLite database for a specific workspace if open.
 */
export function closeWorkspaceDatabase(workspaceRoot: string): void {
  const absRoot = canonicalizePath(workspaceRoot);
  const db = dbRegistry.get(absRoot);
  if (db) {
    try {
      db.close();
    } catch {
      // ignore error if already closed
    }
    dbRegistry.delete(absRoot);
  }
}

/**
 * Closes all open SQLite workspace database connections cleanly.
 */
export function closeAllDatabases(): void {
  for (const [_, db] of dbRegistry.entries()) {
    try {
      db.close();
    } catch {
      // ignore error if already closed
    }
  }
  dbRegistry.clear();
}

/**
 * Initializes table schemas and indexes if they do not exist.
 * Uses PRAGMA user_version to fast-path warm connection opens without repeating DDL/ALTER statements.
 */
export function initSchema(db: Database): void {
  const userVersion = (db.query('PRAGMA user_version;').get() as { user_version: number } | null)?.user_version ?? 0;
  if (userVersion === SCHEMA_USER_VERSION) {
    const coreTables = (
      db
        .query(
          "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'components', 'edges', 'state_deps', 'routes', 'file_dependencies')"
        )
        .get() as { c: number } | null
    )?.c ?? 0;
    if (coreTables === 7) {
      return;
    }
  }

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
      content_hash TEXT,
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
      payload_json TEXT,
      UNIQUE(parent_file_id, child_file_id, import_type)
    );

    CREATE TABLE IF NOT EXISTS state_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      identifier TEXT NOT NULL,
      access_mode TEXT DEFAULT 'read' CHECK(access_mode IN ('read', 'write', 'watch')),
      line_number INTEGER DEFAULT 0,
      usage_snippet TEXT,
      accessed_properties TEXT
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

    CREATE TABLE IF NOT EXISTS file_dependencies (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dependency_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      is_external INTEGER DEFAULT 0,
      PRIMARY KEY (file_id, dependency_path)
    );
  `);

  // Auto-migration: ensure existing databases get new columns before indexing
  const tableColumnsCache = new Map<string, Set<string>>();
  function addColumnIfNotExists(table: string, columnDef: string): void {
    const colName = columnDef.trim().split(/\s+/)[0];
    let cols = tableColumnsCache.get(table);
    if (!cols) {
      const info = db.query(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
      cols = new Set(info.map((c) => c.name));
      tableColumnsCache.set(table, cols);
    }
    if (cols.has(colName)) return;
    try {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
      cols.add(colName);
    } catch {
      // column already exists
    }
  }

  addColumnIfNotExists('files', 'render_boundary TEXT');
  addColumnIfNotExists('files', 'boundary_directive TEXT');
  addColumnIfNotExists('files', 'content_hash TEXT');
  addColumnIfNotExists('edges', 'payload_json TEXT');
  addColumnIfNotExists('state_deps', "access_mode TEXT DEFAULT 'read' CHECK(access_mode IN ('read', 'write', 'watch'))");
  addColumnIfNotExists('state_deps', 'line_number INTEGER DEFAULT 0');
  addColumnIfNotExists('state_deps', 'usage_snippet TEXT');
  addColumnIfNotExists('state_deps', 'accessed_properties TEXT');

  // Drop legacy redundant indexes if present
  try {
    db.run(`
      DROP INDEX IF EXISTS idx_files_path;
      DROP INDEX IF EXISTS idx_routes_url;
      DROP INDEX IF EXISTS idx_state_deps_identifier;
    `);
  } catch {
    // ignore
  }

  // Create indexes safely after tables and columns are guaranteed to exist
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
    CREATE INDEX IF NOT EXISTS idx_edges_parent ON edges(parent_file_id);
    CREATE INDEX IF NOT EXISTS idx_edges_child ON edges(child_file_id);
    CREATE INDEX IF NOT EXISTS idx_state_deps_file ON state_deps(file_id);
    CREATE INDEX IF NOT EXISTS idx_state_deps_ident_mode ON state_deps(identifier, access_mode);
    CREATE INDEX IF NOT EXISTS idx_routes_file ON routes(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_deps_dep_path ON file_dependencies(dependency_path);
    PRAGMA user_version = ${SCHEMA_USER_VERSION};
  `);
}
