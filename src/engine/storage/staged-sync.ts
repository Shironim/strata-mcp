import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, normalize, sep, resolve } from 'node:path';
import type { Database, Statement } from 'bun:sqlite';
import { INDEX_CONFIG_FILES, isConfigFile, iterateFiles } from '../collector';
import { loadAliasConfigWithDependencies } from '../resolver';
import { assertSourceSize } from '../source-file';
import { canonicalizePath } from '../path-resolver';
import { scanRoutes } from '../routes';
import { batchParser } from './delta-sync';
import { SUPPORTED_EXTENSIONS, isLayoutFile } from './schema';
import { isPageFile } from '../tree';
import { STRATA_VERSION } from '../../version';
import type { SyncStats } from '../../types';

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
  let parserInvocations = 0;
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
    const firstPassCache = new Map<string, { hash: string; mtime: number; size: number }>();
    async function scan(statement: Statement, isVerify = false): Promise<void> {
      for await (const raw of iterateFiles(root, {ignoreRoot: root, includeConfigFiles: true, failOnReadError: true})) {
        const config = isConfigFile(basename(raw));
        if (!config && !SUPPORTED_EXTENSIONS.has(extname(raw).toLowerCase())) continue;
        const path = normalize(canonicalizePath(raw));
        let info: { hash: string; mtime: number; size: number };
        if (isVerify) {
          const cached = firstPassCache.get(path);
          if (cached) {
            try {
              const currentStat = await fs.stat(path);
              if (currentStat.mtimeMs === cached.mtime && currentStat.size === cached.size) {
                info = cached;
              } else {
                info = await hashFile(path);
              }
            } catch {
              info = await hashFile(path);
            }
          } else {
            info = await hashFile(path);
          }
        } else {
          info = await hashFile(path);
          firstPassCache.set(path, info);
        }
        statement.run(path, info.hash, info.mtime, info.size, config ? 1 : 0);
      }
    }
    await scan(insert, false);
    const configHash = createHash('sha256').update(STRATA_VERSION).update('\0structural-contract-phase2-v1');
    const configRows = prepare('SELECT path, hash FROM sync_files WHERE config = 1 ORDER BY path');
    for (const row of configRows.iterate() as Iterable<{path: string; hash: string}>) {
      configHash.update(row.path).update('\0').update(row.hash);
      if (/^(tsconfig|jsconfig)(\..+)?\.json$/i.test(basename(row.path))) {
        try {
          const { configFiles } = await loadAliasConfigWithDependencies(row.path);
          for (const extendedPath of configFiles) {
            if (extendedPath !== row.path) {
              try {
                const h = await hashFile(extendedPath);
                configHash.update(extendedPath).update('\0').update(h.hash);
              } catch {}
            }
          }
        } catch {}
      }
    }
    const fingerprint = configHash.digest('hex');
    const reset = meta(db, 'index_invalid') === '1' || meta(db, 'cache_version') !== STRATA_VERSION || meta(db, 'config_fingerprint') !== fingerprint;
    let scope = normalize(reset ? root : targetScope), prefix = scope + sep;
    const scopeSql = '(s.path = $scope OR substr(s.path, 1, length($prefix)) = $prefix)';
    let bindings = {$scope: scope, $prefix: prefix};
    const countFiles = () => db.query(`SELECT
      sum(CASE WHEN f.id IS NULL THEN 1 ELSE 0 END) AS added,
      sum(CASE WHEN f.id IS NOT NULL AND (f.content_hash IS NOT s.hash OR $reset) THEN 1 ELSE 0 END) AS modified,
      sum(CASE WHEN f.id IS NOT NULL AND f.content_hash = s.hash AND NOT $reset THEN 1 ELSE 0 END) AS unchanged,
      count(*) AS total
      FROM sync_files s LEFT JOIN files f ON f.path = s.path WHERE s.config = 0 AND ${scopeSql}`)
      .get({...bindings, $reset: reset ? 1 : 0}) as {added: number; modified: number; unchanged: number; total: number};
    const countDeleted = () => (db.query(`SELECT count(*) AS n FROM files s WHERE ${scopeSql} AND NOT EXISTS (SELECT 1 FROM sync_files t WHERE t.path=s.path AND t.config=0)`).get(bindings) as {n: number}).n;
    let counts = countFiles();
    let deleted = countDeleted();

    const checkDependencyChanges = async (): Promise<Set<string>> => {
      const stale = new Set<string>();
      if (reset) return stale;
      try {
        const deps = db.query(`
          SELECT fd.dependency_path, fd.content_hash, fd.is_external, f.path AS dependent_path
          FROM file_dependencies fd
          JOIN files f ON f.id = fd.file_id
          WHERE (${scopeSql.replace(/s\./g, 'f.')})
        `).all(bindings) as Array<{ dependency_path: string; content_hash: string; is_external: number; dependent_path: string }>;

        for (const dep of deps) {
          if (dep.is_external === 1) {
            try {
              const h = await hashFile(dep.dependency_path);
              if (h.hash !== dep.content_hash) {
                stale.add(dep.dependent_path);
              }
            } catch {
              if (dep.content_hash !== '') {
                stale.add(dep.dependent_path);
              }
            }
          } else {
            const syncRow = db.query('SELECT hash FROM sync_files WHERE path = ?').get(dep.dependency_path) as { hash: string } | null;
            if (syncRow) {
              if (syncRow.hash !== dep.content_hash) {
                stale.add(dep.dependent_path);
              }
            } else {
              if (dep.content_hash !== '') {
                stale.add(dep.dependent_path);
              }
            }
          }
        }
      } catch {
        // file_dependencies table may not exist yet on uninitialized DB
      }
      return stale;
    };
    const staleDependents = await checkDependencyChanges();
    const staleCount = staleDependents.size;

    // Collect direct mutations (added, modified, deleted, stale secondary dependencies)
    const directMutations = new Set<string>();
    const addedRows = db.query(`SELECT s.path FROM sync_files s LEFT JOIN files f ON f.path = s.path WHERE s.config = 0 AND f.id IS NULL AND ${scopeSql}`).all(bindings) as Array<{ path: string }>;
    for (const r of addedRows) directMutations.add(r.path);

    const modifiedRows = db.query(`SELECT s.path FROM sync_files s JOIN files f ON f.path = s.path WHERE s.config = 0 AND (f.content_hash IS NOT s.hash OR $reset) AND ${scopeSql}`).all({...bindings, $reset: reset ? 1 : 0}) as Array<{ path: string }>;
    for (const r of modifiedRows) directMutations.add(r.path);

    const deletedFilesList = db.query(`SELECT s.path FROM files s WHERE ${scopeSql} AND NOT EXISTS (SELECT 1 FROM sync_files t WHERE t.path=s.path AND t.config=0)`).all(bindings) as Array<{ path: string }>;
    for (const r of deletedFilesList) directMutations.add(r.path);

    for (const p of staleDependents) directMutations.add(p);

    // Compute minimal impacted set via transitive reverse dependencies (file_dependencies and edges)
    const impactedSet = new Set<string>(directMutations);
    let hasOutsideDependents = false;
    if (!reset && directMutations.size > 0) {
      const queue = Array.from(directMutations);

      // If new files were added, inspect existing workspace files that reference the newly added symbol/component name
      if (addedRows.length > 0) {
        const addedBaseNames = addedRows.map(r => basename(r.path, extname(r.path))).filter(n => n.length > 0);
        const existingFiles = db.query('SELECT path FROM files').all() as Array<{ path: string }>;
        for (const f of existingFiles) {
          if (!impactedSet.has(f.path)) {
            try {
              const code = await fs.readFile(f.path, 'utf8');
              if (addedBaseNames.some(base => code.includes(base))) {
                impactedSet.add(f.path);
                queue.push(f.path);
              }
            } catch {}
          }
        }
      }

      const findReverseFileDeps = prepare(`
        SELECT f.path AS dependent_path
        FROM file_dependencies fd
        JOIN files f ON f.id = fd.file_id
        WHERE fd.dependency_path = ?
      `);
      const findReverseEdgeParents = prepare(`
        SELECT p.path AS parent_path
        FROM edges e
        JOIN files p ON p.id = e.parent_file_id
        JOIN files c ON c.id = e.child_file_id
        WHERE c.path = ?
      `);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        try {
          for (const row of findReverseFileDeps.all(curr) as Array<{ dependent_path: string }>) {
            const depPath = row.dependent_path;
            const inCurrentScope = depPath === scope || depPath.startsWith(prefix);
            if (!inCurrentScope) {
              hasOutsideDependents = true;
            }
            if (!impactedSet.has(depPath)) {
              impactedSet.add(depPath);
              queue.push(depPath);
            }
          }
        } catch {}

        try {
          for (const row of findReverseEdgeParents.all(curr) as Array<{ parent_path: string }>) {
            const parentPath = row.parent_path;
            const inCurrentScope = parentPath === scope || parentPath.startsWith(prefix);
            if (!inCurrentScope) {
              hasOutsideDependents = true;
            }
            if (!impactedSet.has(parentPath)) {
              impactedSet.add(parentPath);
              queue.push(parentPath);
            }
          }
        } catch {}
      }
    }

    let fallbackReason: 'INDEX_INVALIDATED' | 'DEPENDENCY_CLOSURE_UNVERIFIED' | null = reset && targetScope !== root ? 'INDEX_INVALIDATED' : null;
    if (!reset && scope !== root && (hasOutsideDependents || directMutations.size > 0)) {
      // If scoped sync has outside reverse dependents or mutations that could reach outside,
      // fallback conservatively to root to guarantee complete reverse graph correctness
      scope = root;
      prefix = scope + sep;
      bindings = { $scope: scope, $prefix: prefix };
      counts = countFiles();
      deleted = countDeleted();
      fallbackReason = 'DEPENDENCY_CLOSURE_UNVERIFIED';
    }

    const changed = reset || directMutations.size > 0;
    if (changed) {
      // Rebuild impacted candidates: only parse files within the impacted set (or full scope on reset)
      let candidatesIterable: Iterable<{ path: string; hash: string }>;
      if (reset) {
        const candidates = prepare(`SELECT path, hash FROM sync_files s WHERE config=0 AND ${scopeSql} ORDER BY path`);
        candidatesIterable = candidates.iterate(bindings) as Iterable<{ path: string; hash: string }>;
      } else {
        const checkSync = prepare('SELECT path, hash FROM sync_files WHERE path = ? AND config = 0');
        const reparseCandidates: Array<{ path: string; hash: string }> = [];
        for (const p of Array.from(impactedSet).sort()) {
          const inEffectiveScope = scope === root || p === scope || p.startsWith(prefix);
          if (!inEffectiveScope) continue;
          const row = checkSync.get(p) as { path: string; hash: string } | null;
          if (row) {
            reparseCandidates.push(row);
          }
        }
        candidatesIterable = reparseCandidates;
      }

      const update = prepare('UPDATE sync_files SET payload = ? WHERE path = ?');
      for (const row of candidatesIterable) {
        try {
          parserInvocations++;
          const parsed = await batchParser([row.path], root, new Map(), false);
          const payload = parsed.files.get(row.path);
          if (!payload) throw new Error('PARSE_FAILED: parser returned no result');
          if ((await hashFile(row.path)).hash !== row.hash) throw new Error('WORKSPACE_CHANGED: file changed during analysis');
          const inputDeps = payload.dependencies ?? payload.contract?.dependencies;
          if (Array.isArray(inputDeps)) {
            for (const dep of inputDeps) {
              if (dep.hash !== '') {
                try {
                  const depH = await hashFile(dep.path);
                  if (depH.hash !== dep.hash) throw new Error('WORKSPACE_CHANGED: secondary dependency changed during analysis');
                } catch {
                  throw new Error('WORKSPACE_CHANGED: secondary dependency missing during analysis');
                }
              }
            }
          }
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
    await scan(verifyInsert, true);
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
        db.run('DELETE FROM temp.sync_preserved_edges');
        if (reset) {
          // Full scope reset publication
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
          const insertState = prepare('INSERT INTO state_deps(file_id,kind,identifier,access_mode,line_number,usage_snippet,accessed_properties) SELECT id,?,?,?,?,?,? FROM files WHERE path=?');
          const insertDep = prepare('INSERT OR REPLACE INTO file_dependencies(file_id,dependency_path,content_hash,is_external) SELECT id,?,?,? FROM files WHERE path=?');
          for (const row of rows.iterate() as Iterable<{path: string; hash: string; mtime: number; size: number; payload: string}>) {
            const p = JSON.parse(row.payload);
            insertFile.run(row.path, p.framework, row.mtime, row.size, row.hash, isPageFile(row.path) ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null);
            insertComponent.run(p.compName, JSON.stringify(p.contract), row.path);
            const deps = p.stateDeps.items?.length ? p.stateDeps.items : [
              ...p.stateDeps.stores.map((identifier: string) => ({kind: 'store', identifier})),
              ...p.stateDeps.contexts.map((identifier: string) => ({kind: 'context', identifier})),
              ...p.stateDeps.composables.map((identifier: string) => ({kind: 'composable', identifier})),
            ];
            for (const dep of deps) insertState.run(dep.kind, dep.identifier, dep.accessMode ?? 'read', dep.lineNumber ?? 0, dep.usageSnippet ?? null, dep.accessedProperties ? JSON.stringify(dep.accessedProperties) : null, row.path);
            const inputDeps = p.dependencies ?? p.contract?.dependencies;
            if (Array.isArray(inputDeps)) {
              for (const dep of inputDeps) {
                insertDep.run(dep.path, dep.hash, dep.isExternal ? 1 : 0, row.path);
              }
            }
          }
          // Join target paths on disk after all rows exist; no global file-id map in RAM.
          db.run(`INSERT OR IGNORE INTO edges(parent_file_id,child_file_id,import_type,is_rendered,payload_json)
            SELECT parent.id,child.id,CASE WHEN json_extract(edge.value,'$.isDynamic') THEN 'dynamic' ELSE 'static' END,
              CASE WHEN json_extract(edge.value,'$.isRendered') = 1 OR json_extract(edge.value,'$.isRendered') = true THEN 1 ELSE 0 END,
              json_extract(edge.value,'$.payload')
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
        } else {
          // Minimal Incremental Impact Set publication
          // 1. Remove deleted files
          const deleteFile = prepare('DELETE FROM files WHERE path = ?');
          for (const d of deletedFilesList) {
            deleteFile.run(d.path);
          }

          // 2. For re-parsed files with payload:
          const checkFileExists = prepare('SELECT id FROM files WHERE path = ?');
          const updateFile = prepare('UPDATE files SET framework = ?, mtime = ?, size = ?, content_hash = ?, is_page = ?, is_layout = ?, render_boundary = ?, boundary_directive = ? WHERE path = ?');
          const insertFile = prepare('INSERT INTO files(path,framework,mtime,size,content_hash,is_page,is_layout,render_boundary,boundary_directive) VALUES (?,?,?,?,?,?,?,?,?)');

          const clearComponents = prepare('DELETE FROM components WHERE file_id = ?');
          const clearState = prepare('DELETE FROM state_deps WHERE file_id = ?');
          const clearFileDeps = prepare('DELETE FROM file_dependencies WHERE file_id = ?');
          const clearOutgoingEdges = prepare('DELETE FROM edges WHERE parent_file_id = ?');

          const insertComponent = prepare('INSERT INTO components(file_id,name,contract_json) SELECT id,?,? FROM files WHERE path=?');
          const insertState = prepare('INSERT INTO state_deps(file_id,kind,identifier,access_mode,line_number,usage_snippet,accessed_properties) SELECT id,?,?,?,?,?,? FROM files WHERE path=?');
          const insertDep = prepare('INSERT OR REPLACE INTO file_dependencies(file_id,dependency_path,content_hash,is_external) SELECT id,?,?,? FROM files WHERE path=?');

          const reparseRows = prepare('SELECT path, hash, mtime, size, payload FROM sync_files WHERE payload IS NOT NULL ORDER BY path');
          for (const row of reparseRows.iterate() as Iterable<{path: string; hash: string; mtime: number; size: number; payload: string}>) {
            const p = JSON.parse(row.payload);
            const existing = checkFileExists.get(row.path) as { id: number } | null;
            if (existing) {
              updateFile.run(p.framework, row.mtime, row.size, row.hash, isPageFile(row.path) ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null, row.path);
              clearComponents.run(existing.id);
              clearState.run(existing.id);
              clearFileDeps.run(existing.id);
              clearOutgoingEdges.run(existing.id);
            } else {
              insertFile.run(row.path, p.framework, row.mtime, row.size, row.hash, isPageFile(row.path) ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null);
            }

            insertComponent.run(p.compName, JSON.stringify(p.contract), row.path);
            const deps = p.stateDeps.items?.length ? p.stateDeps.items : [
              ...p.stateDeps.stores.map((identifier: string) => ({kind: 'store', identifier})),
              ...p.stateDeps.contexts.map((identifier: string) => ({kind: 'context', identifier})),
              ...p.stateDeps.composables.map((identifier: string) => ({kind: 'composable', identifier})),
            ];
            for (const dep of deps) insertState.run(dep.kind, dep.identifier, dep.accessMode ?? 'read', dep.lineNumber ?? 0, dep.usageSnippet ?? null, dep.accessedProperties ? JSON.stringify(dep.accessedProperties) : null, row.path);
            const inputDeps = p.dependencies ?? p.contract?.dependencies;
            if (Array.isArray(inputDeps)) {
              for (const dep of inputDeps) {
                insertDep.run(dep.path, dep.hash, dep.isExternal ? 1 : 0, row.path);
              }
            }
          }

          // 3. Re-link outgoing edges from re-parsed files
          db.run(`INSERT OR IGNORE INTO edges(parent_file_id,child_file_id,import_type,is_rendered,payload_json)
            SELECT parent.id,child.id,CASE WHEN json_extract(edge.value,'$.isDynamic') THEN 'dynamic' ELSE 'static' END,
              CASE WHEN json_extract(edge.value,'$.isRendered') = 1 OR json_extract(edge.value,'$.isRendered') = true THEN 1 ELSE 0 END,
              json_extract(edge.value,'$.payload')
            FROM sync_files staged JOIN files parent ON parent.path=staged.path,
            json_each(staged.payload,'$.edges') edge JOIN files child ON child.path=json_extract(edge.value,'$.targetPath')
            WHERE staged.payload IS NOT NULL`);
        }
      }
      db.run('DELETE FROM routes');
      db.run(`INSERT INTO routes(url_path,file_id,type,params_json,handlers_json,layout_chain_json)
        SELECT r.url,f.id,r.type,r.params,r.handlers,r.layouts FROM sync_routes r JOIN files f ON f.path=r.path`);
      const setMeta = prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
      setMeta.run('cache_version', STRATA_VERSION); setMeta.run('config_fingerprint', fingerprint);
      setMeta.run('sync_generation', String(Number(generation || 0) + 1));
      setMeta.run('index_invalid', '');
    });
    commit();
    return {
      added: counts.added ?? 0,
      modified: (counts.modified ?? 0) + staleCount,
      deleted,
      unchanged: counts.unchanged ?? 0,
      parserInvocations,
      total: counts.total,
      durationMs: Math.round(performance.now() - start),
      syncGeneration: Number(generation || 0) + 1,
      configFingerprint: fingerprint,
      cacheHit: !changed,
      scope: { requested: targetScope, effective: scope, fallbackReason },
    };
  } catch (err) {
    // Derived data cannot be trusted after an unreadable file or an unsuccessful refresh.
    const isBusy =
      (err as { code?: string })?.code === 'SQLITE_BUSY' ||
      (err instanceof Error && (err.message.includes('locked') || err.message.includes('busy') || err.message.includes('SQLITE_BUSY')));
    if (!isBusy && !(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) {
      try {
        db.transaction(() => {
          db.run('DELETE FROM files'); db.run("INSERT OR REPLACE INTO meta VALUES ('index_invalid', '1')");
        })();
      } catch {
        // ignore if database cannot be written during clean up
      }
    }
    throw err;
  } finally {
    for (const statement of statements) statement.finalize();
    db.run('DROP TABLE IF EXISTS temp.sync_files; DROP TABLE IF EXISTS temp.sync_verify; DROP TABLE IF EXISTS temp.sync_routes;');
  }
}
