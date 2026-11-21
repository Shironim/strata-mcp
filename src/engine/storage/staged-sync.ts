import { isSqliteBusy } from './sqlite-errors';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join, normalize, sep, resolve } from 'node:path';
import type { Database, Statement } from 'bun:sqlite';
import { isConfigFile, iterateFiles } from '../collector';
import { checkAnalysisCancelled, analysisSignal, reportAnalysisProgress } from '../analysis-context';
import { setTelemetryStage } from '../telemetry';
import { loadAliasConfigWithDependencies } from '../resolver';
import { assertSourceSize } from '../source-file';
import { canonicalizePath } from '../path-resolver';
import { scanRoutes } from '../routes';
import { resolveNextAppRoot, resolveProjectOwnership } from '../project-ownership';
import { batchParser, type ParsedFilePayload } from './index-payload';
import { assertCompatibleSchema, IndexSchemaTooNewError, SUPPORTED_EXTENSIONS, isLayoutFile } from './schema';
import { isSameMonorepoBoundary } from '../graph/path-helpers';
import { buildAutoComponentCatalog, isComponentCandidate } from '../graph/component-relationships';
import { ANALYSIS_FINGERPRINT, STRATA_VERSION } from '../../version';
import type { SyncStats, StateDependencyItem } from '../../types';

async function hashFile(path: string): Promise<{hash: string; mtime: number; size: number}> {
  checkAnalysisCancelled();
  const file = await fs.open(path, 'r');
  try {
    const before = await file.stat(); assertSourceSize(before.size, path);
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
    while (true) {
      checkAnalysisCancelled();
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

/** Stage parsing before publishing a coherent index transaction. */
export async function stagedSync(root: string, scopePath: string | undefined, db: Database): Promise<SyncStats> {
  setTelemetryStage('sync');
  assertCompatibleSchema(db);
  const start = performance.now(); const statements: Statement[] = [];
  let parserInvocations = 0;
  const prepare = (sql: string) => { const stmt = db.prepare(sql); statements.push(stmt); return stmt; };
  const generation = meta(db, 'sync_generation');
  const targetScope = scopePath ? canonicalizePath(resolve(root, scopePath)) : root;
  try {
    db.run(`
      PRAGMA temp_store = FILE;
      DROP TABLE IF EXISTS temp.sync_files; DROP TABLE IF EXISTS temp.sync_verify;
      DROP TABLE IF EXISTS temp.sync_routes;
      CREATE TEMP TABLE sync_files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL, size INTEGER, config INTEGER, payload TEXT);
      CREATE TEMP TABLE sync_verify(path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL, size INTEGER, config INTEGER);
      CREATE TEMP TABLE sync_routes(url TEXT PRIMARY KEY, path TEXT, type TEXT, params TEXT, handlers TEXT, layouts TEXT);
    `);
    const insert = prepare('INSERT INTO sync_files(path, hash, mtime, size, config) VALUES (?,?,?,?,?)');
    const verifyInsert = prepare('INSERT INTO sync_verify VALUES (?,?,?,?,?)');
    const firstPassCache = new Map<string, { hash: string; mtime: number; size: number }>();
    async function scan(statement: Statement, isVerify = false): Promise<void> {
      for await (const raw of iterateFiles(root, {ignoreRoot: root, includeConfigFiles: true, failOnReadError: true})) {
        checkAnalysisCancelled();
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
    reportAnalysisProgress(1, 3, 'Scanned workspace files');
    const configHash = createHash('sha256');
    const checkedOwners = new Set<string>();
    const nextAppRoots = new Map<string, string | null>();
    function recordNextAppRoot(input: string): void {
      const directory = dirname(input);
      if (checkedOwners.has(directory)) return;
      checkedOwners.add(directory);
      const owner = resolveProjectOwnership(input);
      if (owner.applicationFramework !== 'next' || !owner.ownerRoot || nextAppRoots.has(owner.ownerRoot)) return;
      nextAppRoots.set(owner.ownerRoot, owner.appRoot);
      configHash.update(JSON.stringify(['next-app-root', owner.ownerRoot, owner.appRoot])).update('\n');
    }
    // A subdirectory index can inherit its app root from outside its own file scan.
    recordNextAppRoot(join(root, '__strata_route_probe__.ts'));
    const configRows = prepare('SELECT path, hash FROM sync_files WHERE config = 1 ORDER BY path');
    for (const row of configRows.iterate() as Iterable<{path: string; hash: string}>) {
      configHash.update(JSON.stringify([row.path, row.hash])).update('\n');
      const name = basename(row.path);
      if (name === 'package.json' || /^next\.config\./.test(name)) recordNextAppRoot(row.path);
      if (/^(tsconfig|jsconfig)(\..+)?\.json$/i.test(name)) {
        try {
          const { configFiles } = await loadAliasConfigWithDependencies(row.path);
          for (const extendedPath of configFiles) {
            if (extendedPath !== row.path) {
              try {
                const h = await hashFile(extendedPath);
                configHash.update(JSON.stringify([extendedPath, h.hash])).update('\n');
              } catch {}
            }
          }
        } catch {}
      }
    }
    const fingerprint = configHash.digest('hex');
    const reset = meta(db, 'index_invalid') === '1'
      || meta(db, 'analysis_fingerprint') !== ANALYSIS_FINGERPRINT
      || meta(db, 'config_fingerprint') !== fingerprint;
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
    let staleDependents = await checkDependencyChanges();
    let fallbackReason: NonNullable<SyncStats['scope']>['fallbackReason'] = reset && targetScope !== root ? 'INDEX_INVALIDATED' : null;
    // Decide scope before deriving mutations, deletions or reverse dependencies.
    if (!reset && scope !== root && (counts.added || counts.modified || deleted || staleDependents.size)) {
      scope = root;
      prefix = scope + sep;
      bindings = { $scope: scope, $prefix: prefix };
      counts = countFiles();
      deleted = countDeleted();
      staleDependents = await checkDependencyChanges();
      fallbackReason = 'DEPENDENCY_CLOSURE_UNVERIFIED';
    }
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
    if (!reset && directMutations.size > 0) {
      const queue = Array.from(directMutations);
      // A name can become ambiguous or unique without changing any of its consumers.
      const catalogChanges = [...addedRows, ...deletedFilesList].filter(row => isComponentCandidate(row.path));
      if (catalogChanges.length > 0) {
        for (const row of db.query('SELECT path FROM sync_files WHERE config = 0').iterate() as Iterable<{ path: string }>) {
          if (!/\.(vue|astro|svelte)$/i.test(row.path) || impactedSet.has(row.path)) continue;
          if (!catalogChanges.some(change => isSameMonorepoBoundary(row.path, change.path))) continue;
          impactedSet.add(row.path);
          queue.push(row.path);
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

      for (let cursor = 0; cursor < queue.length; cursor++) {
        checkAnalysisCancelled();
        const curr = queue[cursor];
        for (const row of findReverseFileDeps.all(curr) as Array<{ dependent_path: string }>) {
          const depPath = row.dependent_path;
          if (!impactedSet.has(depPath)) {
            impactedSet.add(depPath);
            queue.push(depPath);
          }
        }

        for (const row of findReverseEdgeParents.all(curr) as Array<{ parent_path: string }>) {
          const parentPath = row.parent_path;
          if (!impactedSet.has(parentPath)) {
            impactedSet.add(parentPath);
            queue.push(parentPath);
          }
        }
      }
    }

    const changed = reset || directMutations.size > 0;
    if (changed) {
      const catalog = buildAutoComponentCatalog(Array.from(
        db.query('SELECT path FROM sync_files WHERE config = 0').iterate() as Iterable<{ path: string }>, row => row.path,
      ));
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
        checkAnalysisCancelled();
        parserInvocations++;
        const parsed = await batchParser([row.path], root, new Map(), false, catalog);
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
      }
    }
    // Routes must be refreshed even when no source delta exists or the new manifest is empty.
    const manifest = await scanRoutes({targetPath: root});
    const routeInsert = prepare('INSERT OR REPLACE INTO sync_routes VALUES (?,?,?,?,?,?)');
    for (const route of manifest.routes) routeInsert.run(route.path, normalize(canonicalizePath(route.filePath)), route.type, JSON.stringify(route.params), JSON.stringify(route.handlers ?? null), JSON.stringify(route.layouts ?? null));
    manifest.routes.length = 0;
    const routeHash = createHash('sha256');
    for (const row of db.query('SELECT * FROM sync_routes ORDER BY url').iterate()) routeHash.update(JSON.stringify(row));
    const routesFingerprint = routeHash.digest('hex');
    const snapshotChanged = changed || meta(db, 'routes_fingerprint') !== routesFingerprint;
    const nextGeneration = Number(generation || 0) + (snapshotChanged ? 1 : 0);
    await scan(verifyInsert, true);
    for (const [owner, appRoot] of nextAppRoots) {
      if (resolveNextAppRoot(owner) !== appRoot) throw new Error('WORKSPACE_CHANGED: Next App Router root changed during sync');
    }
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
    checkAnalysisCancelled();
    reportAnalysisProgress(2, 3, 'Committing graph index');
    const commit = db.transaction(() => {
      assertCompatibleSchema(db);
      if (meta(db, 'sync_generation') !== generation) throw new Error('WORKSPACE_CHANGED: concurrent index publication');
      if (changed) {
        if (reset) db.run('DELETE FROM files');
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
          const p = JSON.parse(row.payload) as ParsedFilePayload;
          const existing = checkFileExists.get(row.path) as { id: number } | null;
          if (existing) {
            updateFile.run(p.framework, row.mtime, row.size, row.hash, p.isPage ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null, row.path);
            clearComponents.run(existing.id);
            clearState.run(existing.id);
            clearFileDeps.run(existing.id);
            clearOutgoingEdges.run(existing.id);
          } else {
            insertFile.run(row.path, p.framework, row.mtime, row.size, row.hash, p.isPage ? 1 : 0, isLayoutFile(row.path) ? 1 : 0, p.boundary.boundary, p.boundary.directive ?? null);
          }

          insertComponent.run(p.compName, JSON.stringify(p.contract), row.path);
          const deps: StateDependencyItem[] = p.stateDeps.items?.length ? p.stateDeps.items : [
            ...p.stateDeps.stores.map<StateDependencyItem>(identifier => ({kind: 'store', identifier, accessMode: 'read'})),
            ...p.stateDeps.contexts.map<StateDependencyItem>(identifier => ({kind: 'context', identifier, accessMode: 'read'})),
            ...p.stateDeps.composables.map<StateDependencyItem>(identifier => ({kind: 'composable', identifier, accessMode: 'read'})),
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
          SELECT parent.id,child.id,CASE WHEN json_extract(edge.value,'$.isAutoImported') THEN 'auto'
            WHEN json_extract(edge.value,'$.isDynamic') THEN 'dynamic' ELSE 'static' END,
            CASE WHEN json_extract(edge.value,'$.isRendered') = 1 OR json_extract(edge.value,'$.isRendered') = true THEN 1 ELSE 0 END,
            json_extract(edge.value,'$.payload')
          FROM sync_files staged JOIN files parent ON parent.path=staged.path,
          json_each(staged.payload,'$.edges') edge JOIN files child ON child.path=json_extract(edge.value,'$.targetPath')
          WHERE staged.payload IS NOT NULL
          ORDER BY json_extract(edge.value,'$.isRendered') DESC`);
      }
      db.run('DELETE FROM routes');
      db.run(`INSERT INTO routes(url_path,file_id,type,params_json,handlers_json,layout_chain_json)
        SELECT r.url,f.id,r.type,r.params,r.handlers,r.layouts FROM sync_routes r JOIN files f ON f.path=r.path`);
      const setMeta = prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
      if (snapshotChanged) setMeta.run('cache_version', STRATA_VERSION);
      setMeta.run('analysis_fingerprint', ANALYSIS_FINGERPRINT);
      setMeta.run('config_fingerprint', fingerprint);
      setMeta.run('sync_generation', String(nextGeneration));
      setMeta.run('routes_fingerprint', routesFingerprint);
      setMeta.run('index_invalid', '');
    });
    commit.immediate();
    return {
      added: counts.added ?? 0,
      modified: (counts.modified ?? 0) + staleCount,
      deleted,
      unchanged: counts.unchanged ?? 0,
      parserInvocations,
      total: counts.total,
      durationMs: Math.round(performance.now() - start),
      syncGeneration: nextGeneration,
      configFingerprint: fingerprint,
      analysisFingerprint: ANALYSIS_FINGERPRINT,
      cacheHit: !snapshotChanged,
      scope: { requested: targetScope, effective: scope, fallbackReason },
    };
  } catch (err) {
    if (analysisSignal()?.aborted || err instanceof IndexSchemaTooNewError) throw err;
    // Derived data cannot be trusted after an unreadable file or an unsuccessful refresh.
    const isBusy = isSqliteBusy(err);
    if (!isBusy && !(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) {
      try {
        db.transaction(() => {
          assertCompatibleSchema(db);
          if (meta(db, 'sync_generation') !== generation) return;
          db.run('DELETE FROM files'); db.run("INSERT OR REPLACE INTO meta VALUES ('index_invalid', '1')");
        }).immediate();
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
