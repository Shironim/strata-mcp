import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  stopAllWorkspaceWatchers,
} from '../watcher';

export const SUPPORTED_EXTENSIONS = new Set(['.vue', '.astro', '.tsx', '.jsx', '.ts', '.js']);

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

export const dbRegistry = new Map<string, Database>();

/**
 * Opens or initializes a SQLite database for the workspace with WAL mode.
 * Reuses existing open database instances for the same workspace.
 */
export function getWorkspaceDatabase(workspaceRoot: string): Database {
  const absRoot = resolve(workspaceRoot);
  const existing = dbRegistry.get(absRoot);
  if (existing) {
    return existing;
  }

  const dbDir = join(absRoot, '.strata');

  if (!existsSync(dbDir)) {
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

  // Enable WAL mode & foreign keys for high-concurrency performance
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA busy_timeout = 5000;');

  initSchema(db);
  dbRegistry.set(absRoot, db);

  // Start reactive background watcher for instant cache updates
  startWorkspaceWatcher(absRoot, db);

  return db;
}

/**
 * Closes the SQLite database for a specific workspace if open.
 */
export function closeWorkspaceDatabase(workspaceRoot: string): void {
  const absRoot = resolve(workspaceRoot);
  stopWorkspaceWatcher(absRoot);
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
  stopAllWorkspaceWatchers();
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
 */
export function initSchema(db: Database): void {
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
      usage_snippet TEXT
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
    CREATE INDEX IF NOT EXISTS idx_state_deps_ident_mode ON state_deps(identifier, access_mode);
    CREATE INDEX IF NOT EXISTS idx_routes_url ON routes(url_path);
  `);

  // Auto-migration: ensure existing databases get payload_json column
  try {
    db.run('ALTER TABLE edges ADD COLUMN payload_json TEXT;');
  } catch {
    // column already exists
  }

  // Auto-migration: ensure existing databases get access_mode, line_number, usage_snippet columns
  try {
    db.run("ALTER TABLE state_deps ADD COLUMN access_mode TEXT DEFAULT 'read' CHECK(access_mode IN ('read', 'write', 'watch'));");
  } catch {
    // column already exists
  }
  try {
    db.run('ALTER TABLE state_deps ADD COLUMN line_number INTEGER DEFAULT 0;');
  } catch {
    // column already exists
  }
  try {
    db.run('ALTER TABLE state_deps ADD COLUMN usage_snippet TEXT;');
  } catch {
    // column already exists
  }
}
