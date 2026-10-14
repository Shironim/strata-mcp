import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, normalize, sep, resolve } from 'node:path';
import type { Database, Statement } from 'bun:sqlite';
import { iterateFiles } from '../collector';
import { assertSourceSize } from '../source-file';
import { canonicalizePath } from '../path-resolver';
import { scanRoutes } from '../routes';
import { batchParser } from './delta-sync';
import { SUPPORTED_EXTENSIONS, isLayoutFile } from './schema';
import { isPageFile } from '../tree';
import { STRATA_VERSION } from '../../version';
import type { SyncStats } from '../../types';

// Reparse imports and state dependencies after AST extraction fixes.
const CACHE_VERSION = `memory-v4:${STRATA_VERSION}`;
const CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', '.gitignore', '.strataignore']);

async function hashFile(path: string): Promise<{hash: string; mtime: number; size: number}> {
  const file = await fs.open(path, 'r');
  try {
    const before = await file.stat(); assertSourceSize(before.size, path);
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead; assertSourceSize(size, path); hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || after.size !== size) throw new Error('WORKSPACE_CHANGED: file changed while hashing');
    return {hash: hash.digest('hex'), mtime: after.mtimeMs, size};
  } finally { await file.close(); }
}

function meta(db: Database, key: string): string {
  return (db.query('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | null)?.value ?? '';
}

/** TEMP tables spill to disk and disappear even after a killed worker. */
export async function stagedSync(root: string, scopePath: string | undefined, db: Database): Promise<SyncStats> {
  const start = performance.now(); const statements: Statement[] = [];
  const prepare = (sql: string) => { const stmt = db.prepare(sql); statements.push(stmt); return stmt; };
  const generation = meta(db, 'sync_generation');
  const targetScope = scopePath ? canonicalizePath(resolve(root, scopePath)) : root;
  try {
    db.run(`
      PRAGMA temp_store = FILE;
      DROP TABLE IF EXISTS temp.sync_files; DROP TABLE IF EXISTS temp.sync_verify;
      DROP TABLE IF EXISTS temp.sync_routes; DROP TABLE IF EXISTS temp.sync_preserved_edges;
      CREATE TEMP TABLE sync_files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL, size INTEGER, config INTEGER, payload TEXT);
      CREATE TEMP TABLE sync_verify(path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL, size INTEGER, config INTEGER);
      CREATE TEMP TABLE sync_routes(url TEXT PRIMARY KEY, path TEXT, type TEXT, params TEXT, handlers TEXT, layouts TEXT);
      CREATE TEMP TABLE sync_preserved_edges(parent_path TEXT NOT NULL, child_path TEXT NOT NULL, import_type TEXT NOT NULL, is_rendered INTEGER, payload_json TEXT);
    `);
    const insert = prepare('INSERT INTO sync_files(path, hash, mtime, size, config) VALUES (?,?,?,?,?)');
    const verifyInsert = prepare('INSERT INTO sync_verify VALUES (?,?,?,?,?)');
    async function scan(statement: Statement): Promise<void> {
      for await (const raw of iterateFiles(root, {ignoreRoot: root, includeConfigFiles: true})) {
        const config = CONFIG_FILES.has(basename(raw));
        if (!config && !SUPPORTED_EXTENSIONS.has(extname(raw).toLowerCase())) continue;
        const path = normalize(canonicalizePath(raw)); const info = await hashFile(path);
        statement.run(path, info.hash, info.mtime, info.size, config ? 1 : 0);
      }
    }
    await scan(insert);
    const configHash = createHash('sha256').update(CACHE_VERSION);
    const configRows = prepare('SELECT path, hash FROM sync_files WHERE config = 1 ORDER BY path');
    for (const row of configRows.iterate() as Iterable<{path: string; hash: string}>) configHash.update(row.path).update('\0').update(row.hash);
    const fingerprint = configHash.digest('hex');
    const reset = meta(db, 'index_invalid') === '1' || meta(db, 'cache_version') !== CACHE_VERSION || meta(db, 'config_fingerprint') !== fingerprint;
    const scope = normalize(reset ? root : targetScope), prefix = scope + sep;
    const scopeSql = '(s.path = $scope OR substr(s.path, 1, length($prefix)) = $prefix)';
    const bindings = {$scope: scope, $prefix: prefix};
    const counts = db.query(`SELECT
      sum(CASE WHEN f.id IS NULL THEN 1 ELSE 0 END) AS added,
      sum(CASE WHEN f.id IS NOT NULL AND (f.content_hash IS NOT s.hash OR $reset) THEN 1 ELSE 0 END) AS modified,
      sum(CASE WHEN f.id IS NOT NULL AND f.content_hash = s.hash AND NOT $reset THEN 1 ELSE 0 END) AS unchanged,
      count(*) AS total
      FROM sync_files s LEFT JOIN files f ON f.path = s.path WHERE s.config = 0 AND ${scopeSql}`)
      .get({...bindings, $reset: reset ? 1 : 0}) as {added: number; modified: number; unchanged: number; total: number};
    const deleted = (db.query(`SELECT count(*) AS n FROM files s WHERE ${scopeSql} AND NOT EXISTS (SELECT 1 FROM sync_files t WHERE t.path=s.path AND t.config=0)`).get(bindings) as {n: number}).n;
    const changed = reset || (counts.added ?? 0) + (counts.modified ?? 0) + deleted > 0;
    if (changed) {
      // Rebuild scoped dependents as well: a changed imported type can alter unchanged contracts.
      const candidates = prepare(`SELECT path, hash FROM sync_files s WHERE config=0 AND ${scopeSql} ORDER BY path`);
      const update = prepare('UPDATE sync_files SET payload = ? WHERE path = ?');
      for (const row of candidates.iterate(bindings) as Iterable<{path: string; hash: string}>) {
        try {
          const parsed = await batchParser([row.path], root, new Map(), false);
          const payload = parsed.files.get(row.path);
          if (!payload) throw new Error('PARSE_FAILED: parser returned no result');
          if ((await hashFile(row.path)).hash !== row.hash) throw new Error('WORKSPACE_CHANGED: file changed during analysis');
          update.run(JSON.stringify(payload), row.path);
          parsed.files.clear();
        } catch (err) {
          if (!(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) {
            db.run('DELETE FROM files WHERE path = ?', [row.path]);
            db.run("INSERT OR REPLACE INTO meta VALUES ('index_invalid', '1')");
          }
          throw err;
        }
      }
    }
    // Routes must be refreshed even when no source delta exists or the new manifest is empty.
    const manifest = await scanRoutes({targetPath: root});
    const routeInsert = prepare('INSERT OR REPLACE INTO sync_routes VALUES (?,?,?,?,?,?)');
    for (const route of manifest.routes) routeInsert.run(route.path, normalize(canonicalizePath(route.filePath)), route.type, JSON.stringify(route.params), JSON.stringify(route.handlers ?? null), JSON.stringify(route.layouts ?? null));
    manifest.routes.length = 0;
    await scan(verifyInsert);
    const mismatch = db.query(`
      WITH in_files_only AS (
        SELECT path, hash FROM sync_files EXCEPT SELECT path, hash FROM sync_verify
      ),
      in_verify_only AS (
        SELECT path, hash FROM sync_verify EXCEPT SELECT path, hash FROM sync_files
      )
      SELECT 1 FROM (
        SELECT * FROM in_files_only
        UNION ALL
        SELECT * FROM in_verify_only
      ) LIMIT 1
    `).get();
    if (mismatch || meta(db, 'sync_generation') !== generation) throw new Error('WORKSPACE_CHANGED: workspace or index changed before commit');
    const commit = db.transaction(() => {
      if (meta(db, 'sync_generation') !== generation) throw new Error('WORKSPACE_CHANGED: concurrent index publication');
      if (changed) {
        // Preserve incoming edges from caller files outside scope before cascading delete
        prepare(`INSERT INTO temp.sync_preserved_edges(parent_path, child_path, import_type, is_rendered, payload_json)
          SELECT p.path, c.path, e.import_type, e.is_rendered, e.payload_json
          FROM edges e
          JOIN files c ON c.id = e.child_file_id
          JOIN files p ON p.id = e.parent_file_id
          WHERE (c.path = $scope OR substr(c.path, 1, length($prefix)) = $prefix)
            AND NOT (p.path = $scope OR substr(p.path, 1, length($prefix)) = $prefix)`).run(bindings);
        prepare(`DELETE FROM files AS s WHERE ${scopeSql}`).run(bindings);
        const rows = prepare('SELECT path, hash, mtime, size, payload FROM sync_files WHERE payload IS NOT NULL ORDER BY path');
        const insertFile = prepare('INSERT INTO files(path,framework,mtime,size,content_hash,is_page,is_layout,render_boundary,boundary_directive) VALUES (?,?,?,?,?,?,?,?,?)');
        const insertComponent = prepare('INSERT INTO components(file_id,name,contract_json) SELECT id,?,? FROM files WHERE path=?');
        const insertState = prepare('INSERT INTO state_deps(file_id,kind,identifier,access_mode,line_number,usage_snippet) SELECT id,?,?,?,?,? FROM files WHERE path=?');
        for (const row of rows.iterate() as Iterable<{path: string; hash: string; mtime: number; size: number; payload: string}>) {
          const p = JSON.parse(row.payload);
          insertFile.run(row.path, p.framework, row.mtime, row.size, row.hash, isPageFile(row.path) ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null);
          insertComponent.run(p.compName, JSON.stringify(p.contract), row.path);
          const deps = p.stateDeps.items?.length ? p.stateDeps.items : [
            ...p.stateDeps.stores.map((identifier: string) => ({kind: 'store', identifier})),
            ...p.stateDeps.contexts.map((identifier: string) => ({kind: 'context', identifier})),
            ...p.stateDeps.composables.map((identifier: string) => ({kind: 'composable', identifier})),
          ];
          for (const dep of deps) insertState.run(dep.kind, dep.identifier, dep.accessMode ?? 'read', dep.lineNumber ?? 0, dep.usageSnippet ?? null, row.path);
        }
        // Join target paths on disk after all rows exist; no global file-id map in RAM.
        db.run(`INSERT OR IGNORE INTO edges(parent_file_id,child_file_id,import_type,is_rendered,payload_json)
          SELECT parent.id,child.id,CASE WHEN json_extract(edge.value,'$.isDynamic') THEN 'dynamic' ELSE 'static' END,1,json_extract(edge.value,'$.payload')
          FROM sync_files staged JOIN files parent ON parent.path=staged.path,
          json_each(staged.payload,'$.edges') edge JOIN files child ON child.path=json_extract(edge.value,'$.targetPath')
          WHERE staged.payload IS NOT NULL`);
        // Re-link preserved incoming edges from outside callers to refreshed scope files
        db.run(`INSERT OR IGNORE INTO edges(parent_file_id,child_file_id,import_type,is_rendered,payload_json)
          SELECT p.id, c.id, pie.import_type, pie.is_rendered, pie.payload_json
          FROM temp.sync_preserved_edges pie
          JOIN files p ON p.path = pie.parent_path
          JOIN files c ON c.path = pie.child_path`);
        db.run('DELETE FROM temp.sync_preserved_edges');
      }
      db.run('DELETE FROM routes');
      db.run(`INSERT INTO routes(url_path,file_id,type,params_json,handlers_json,layout_chain_json)
        SELECT r.url,f.id,r.type,r.params,r.handlers,r.layouts FROM sync_routes r JOIN files f ON f.path=r.path`);
      const setMeta = prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
      setMeta.run('cache_version', CACHE_VERSION); setMeta.run('config_fingerprint', fingerprint);
      setMeta.run('sync_generation', String(Number(generation || 0) + 1)); setMeta.run('index_invalid', '');
    });
    commit();
    return {added: counts.added ?? 0, modified: counts.modified ?? 0, deleted, unchanged: counts.unchanged ?? 0, total: counts.total, durationMs: Math.round(performance.now() - start)};
  } catch (err) {
    // Derived data cannot be trusted after an unreadable file or an unsuccessful refresh.
    if (!(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) {
      db.transaction(() => {
        db.run('DELETE FROM files'); db.run("INSERT OR REPLACE INTO meta VALUES ('index_invalid', '1')");
      })();
    }
    throw err;
  } finally {
    for (const statement of statements) statement.finalize();
    db.run('DROP TABLE IF EXISTS temp.sync_files; DROP TABLE IF EXISTS temp.sync_verify; DROP TABLE IF EXISTS temp.sync_routes;');
  }
}
