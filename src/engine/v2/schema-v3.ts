import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizePath } from '../path-resolver';

export const SCHEMA_V3_VERSION = 3;

export interface WarmDbOptions {
  /** Defaults to 'graph.db' (Schema v3). */
  dbFilename?: string;
}

/**
 * Initializes or migrates a SQLite database to Schema v3 (Symbol-First & Package-Partitioned).
 */
export function initSchemaV3(db: Database): void {
  const currentVersion =
    (db.query('PRAGMA user_version').get() as { user_version: number } | null)?.user_version ?? 0;

  if (currentVersion === SCHEMA_V3_VERSION) {
    const count =
      (
        db
          .query(
            "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'packages', 'files', 'symbols', 'symbol_edges', 'routes', 'file_dependencies', 'symbols_fts')"
          )
          .get() as { c: number } | null
      )?.c ?? 0;
    if (count === 8) return;
  }

  db.transaction(() => {
    // Rebuild cleanly when upgrading from pre-v3 schema (index is deterministic cache)
    if (currentVersion > 0 && currentVersion < SCHEMA_V3_VERSION) {
      db.exec(`
        DROP TABLE IF EXISTS symbols_fts;
        DROP TABLE IF EXISTS symbol_edges;
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS routes;
        DROP TABLE IF EXISTS file_dependencies;
        DROP TABLE IF EXISTS components;
        DROP TABLE IF EXISTS edges;
        DROP TABLE IF EXISTS state_deps;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS packages;
        DROP TABLE IF EXISTS meta;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS packages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        package_key   TEXT UNIQUE NOT NULL,
        name          TEXT,
        root_path     TEXT UNIQUE NOT NULL,
        tsconfig_path TEXT,
        framework     TEXT NOT NULL,
        router        TEXT,
        exports_json  TEXT,
        manifest_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id         INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        path               TEXT UNIQUE NOT NULL,
        rel_path           TEXT NOT NULL,
        framework          TEXT NOT NULL,
        mtime              INTEGER NOT NULL,
        size               INTEGER NOT NULL,
        content_hash       TEXT NOT NULL,
        is_page            INTEGER DEFAULT 0,
        is_layout          INTEGER DEFAULT 0,
        render_boundary    TEXT,
        boundary_directive TEXT,
        contract_json      TEXT
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_uid       TEXT UNIQUE NOT NULL,
        file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        package_id       INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        kind             TEXT NOT NULL CHECK (kind IN (
                           'component', 'function', 'class', 'method', 'composable',
                           'store', 'context', 'type', 'interface', 'enum', 'variable',
                           'prop', 'emit', 'slot', 'model'
                         )),
        parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        is_exported      INTEGER DEFAULT 0,
        is_default       INTEGER DEFAULT 0,
        signature        TEXT,
        start_offset     INTEGER NOT NULL,
        end_offset       INTEGER NOT NULL,
        start_line       INTEGER NOT NULL,
        end_line         INTEGER NOT NULL,
        meta_json        TEXT
      );

      CREATE TABLE IF NOT EXISTS symbol_edges (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        target_file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
        target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        target_name      TEXT,
        edge_kind        TEXT NOT NULL CHECK (edge_kind IN (
                           'imports', 'reexports', 'renders', 'calls',
                           'reads_state', 'writes_state', 'watches_state',
                           'passes_prop', 'listens_event', 'provides_context', 'consumes_context',
                           'extends_type', 'outbound_http', 'submits_form'
                         )),
        is_dynamic       INTEGER DEFAULT 0,
        confidence       TEXT DEFAULT 'syntax' CHECK (confidence IN ('syntax', 'semantic', 'heuristic')),
        line_number      INTEGER DEFAULT 0,
        start_offset     INTEGER DEFAULT 0,
        end_offset       INTEGER DEFAULT 0,
        payload_json     TEXT
      );

      CREATE TABLE IF NOT EXISTS routes (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        package_id        INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        url_path          TEXT NOT NULL,
        file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        route_type        TEXT NOT NULL,
        params_json       TEXT,
        handlers_json     TEXT,
        layout_chain_json TEXT,
        UNIQUE(package_id, url_path, route_type)
      );

      CREATE TABLE IF NOT EXISTS file_dependencies (
        file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        dependency_path TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        is_external     INTEGER DEFAULT 0,
        PRIMARY KEY (file_id, dependency_path)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        signature,
        content='symbols',
        content_rowid='id',
        tokenize="unicode61 tokenchars '_$'"
      );

      CREATE INDEX IF NOT EXISTS idx_files_package        ON files(package_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_file         ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_package_kind ON symbols(package_id, kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_name         ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_edges_source_file    ON symbol_edges(source_file_id, edge_kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_file    ON symbol_edges(target_file_id, edge_kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_symbol  ON symbol_edges(target_symbol_id, edge_kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_name    ON symbol_edges(target_name, edge_kind);
      CREATE INDEX IF NOT EXISTS idx_routes_package       ON routes(package_id);
      CREATE INDEX IF NOT EXISTS idx_file_deps_dep_path   ON file_dependencies(dependency_path);

      PRAGMA user_version = ${SCHEMA_V3_VERSION};
    `);
  }).immediate();
}

interface WarmEntry {
  db: Database;
  dbPath: string;
  lastUsedAt: number;
}

/**
 * Warm SQLite connection pool that keeps workspace databases open across tool calls
 * instead of closing them after every request.
 */
export class WarmDatabasePool {
  private readonly entries = new Map<string, WarmEntry>();

  constructor(private readonly idleTtlMs: number = 15 * 60 * 1000) {}

  get(workspaceRoot: string, options: WarmDbOptions = {}): Database {
    const absRoot = canonicalizePath(workspaceRoot);
    const dbFilename = options.dbFilename ?? 'graph.db';
    const key = `${absRoot}\0${dbFilename}`;

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.db;
    }

    const strataDir = join(absRoot, '.strata');
    if (!existsSync(strataDir)) {
      mkdirSync(strataDir, { recursive: true });
      try {
        writeFileSync(join(strataDir, '.gitignore'), '*\n');
      } catch {
        // ignore
      }
    }

    const dbPath = join(strataDir, dbFilename);
    const db = new Database(dbPath, { create: true });
    try {
      db.run('PRAGMA busy_timeout = 15000;');
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA synchronous = NORMAL;');
      db.run('PRAGMA foreign_keys = ON;');
      db.run('PRAGMA cache_size = -16384;');
      initSchemaV3(db);
    } catch (err) {
      db.close();
      throw err;
    }

    this.entries.set(key, { db, dbPath, lastUsedAt: Date.now() });
    return db;
  }

  evictIdle(now = Date.now()): number {
    let evicted = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.lastUsedAt >= this.idleTtlMs) {
        try {
          entry.db.close();
        } catch {
          // ignore
        }
        this.entries.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  close(workspaceRoot: string, dbFilename = 'graph.db'): void {
    const absRoot = canonicalizePath(workspaceRoot);
    const key = `${absRoot}\0${dbFilename}`;
    const entry = this.entries.get(key);
    if (entry) {
      try {
        entry.db.close();
      } catch {
        // ignore
      }
      this.entries.delete(key);
    }
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.db.close();
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export const defaultWarmDbPool = new WarmDatabasePool();
