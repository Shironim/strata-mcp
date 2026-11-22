import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { defaultPluginRegistry } from '../../plugins';
import { canonicalizePath } from '../path-resolver';
import { iterateFiles } from '../collector';
import { scanRoutes } from '../routes';
import { defaultWarmDbPool, type WarmDbOptions } from './schema-v3';
import {
  discoverWorkspacePackages,
  matchOwningPackage,
  type WorkspacePackageInfo,
} from './workspace-packages';
import { extractTier1File, type Tier1ExtractionResult } from './symbol-extractor';
import { DEFAULT_PARALLEL_PARSE_THRESHOLD, parseFilesInWorkerPool } from './parse-pool';
import { linkWorkspaceEdges } from './graph-linker';

export type SyncProgressStage = 'scan' | 'parse' | 'resolve' | 'commit';

export interface SyncProgressEvent {
  stage: SyncProgressStage;
  status: 'start' | 'progress' | 'done';
  completed?: number;
  total?: number;
  detail?: string;
  durationMs?: number;
}

export interface FastSyncOptions extends WarmDbOptions {
  /** Optional packageKey (e.g. "apps/web") to sync only a single package partition. */
  packageKey?: string;
  /** Force full re-extraction ignoring mtime/git fast paths. */
  force?: boolean;
  /** Database instance override (defaults to WarmDatabasePool). */
  db?: Database;
  /** Optional stage-by-stage progress callback for CLI/UI feedback. */
  onProgress?: (event: SyncProgressEvent) => void;
  /** Minimum file count to activate the parallel CPU worker pool (default: 1000). */
  parallelThreshold?: number;
  /** Maximum worker threads for Stage 2 parsing (default: min(cpus - 1, 4)). */
  maxWorkers?: number;
}

export interface FastSyncStats {
  mode: 'git-fast-path' | 'watcher-clean' | 'watcher-dirty' | 'incremental' | 'full';
  packagesSynced: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  durationMs: number;
  workersUsed?: number;
}

function getMeta(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
  return row ? row.value : null;
}

function setMeta(db: Database, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value]);
}

function computeGitStateFingerprint(absRoot: string): string | null {
  if (!existsSync(join(absRoot, '.git'))) return null;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: absRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: absRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    // If working tree is completely clean, HEAD alone guarantees no source file changed
    if (status.trim() === '') {
      return `clean:${head}`;
    }
    return null;
  } catch {
    return null;
  }
}

interface ExtractedBatchItem {
  pkgId: number;
  mtime: number;
  size: number;
  result: Tier1ExtractionResult;
  isNew: boolean;
}

/**
 * Persists deleted files, upserted files, symbols, symbol_edges, incremental FTS5 entries,
 * and cross-file link resolution inside an active SQLite write transaction.
 */
function persistSyncBatch(
  db: Database,
  params: {
    deletedFileIds: number[];
    extractedBatch: ExtractedBatchItem[];
    fileIdByPath: Map<string, number>;
    useFullFtsRebuild: boolean;
    loadAllFilesForEdges: boolean;
  }
): void {
  const { deletedFileIds, extractedBatch, fileIdByPath, useFullFtsRebuild, loadAllFilesForEdges } = params;
  const selectFileSymbolsStmt = db.prepare(
    'SELECT id, name, signature FROM symbols WHERE file_id = ?'
  );
  const deleteFtsStmt = db.prepare(
    "INSERT INTO symbols_fts(symbols_fts, rowid, name, signature) VALUES ('delete', ?, ?, ?)"
  );
  const insertFtsStmt = db.prepare(
    'INSERT INTO symbols_fts(rowid, name, signature) VALUES (?, ?, ?)'
  );

  const removeFileSymbolsFromFts = (fileId: number) => {
    const oldSymbols = selectFileSymbolsStmt.all(fileId) as Array<{
      id: number;
      name: string;
      signature: string | null;
    }>;
    for (const s of oldSymbols) {
      deleteFtsStmt.run(s.id, s.name, s.signature ?? '');
    }
  };

  const deleteFileStmt = db.prepare('DELETE FROM files WHERE id = ?');
  for (const id of deletedFileIds) {
    if (!useFullFtsRebuild) removeFileSymbolsFromFts(id);
    deleteFileStmt.run(id);
  }

  const upsertFileStmt = db.prepare(`
    INSERT INTO files(
      package_id, path, rel_path, framework, mtime, size, content_hash,
      is_page, is_layout, render_boundary, boundary_directive, contract_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      package_id = excluded.package_id,
      rel_path = excluded.rel_path,
      framework = excluded.framework,
      mtime = excluded.mtime,
      size = excluded.size,
      content_hash = excluded.content_hash,
      is_page = excluded.is_page,
      is_layout = excluded.is_layout,
      render_boundary = excluded.render_boundary,
      boundary_directive = excluded.boundary_directive,
      contract_json = excluded.contract_json
  `);
  const selectFileIdStmt = db.prepare('SELECT id FROM files WHERE path = ?');
  const clearSymbolsStmt = db.prepare('DELETE FROM symbols WHERE file_id = ?');
  const clearEdgesStmt = db.prepare('DELETE FROM symbol_edges WHERE source_file_id = ?');

  const insertSymbolStmt = db.prepare(`
    INSERT INTO symbols(
      symbol_uid, file_id, package_id, name, kind, parent_symbol_id,
      is_exported, is_default, signature, start_offset, end_offset, start_line, end_line, meta_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEdgeStmt = db.prepare(`
    INSERT INTO symbol_edges(
      source_file_id, source_symbol_id, target_file_id, target_symbol_id,
      target_name, edge_kind, is_dynamic, confidence, line_number, start_offset, end_offset, payload_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const symbolIdByUid = new Map<string, number>();
  const upsertedFileIds: number[] = [];

  for (const item of extractedBatch) {
    const r = item.result;
    upsertFileStmt.run(
      item.pkgId,
      r.filePath,
      r.relPath,
      r.framework,
      item.mtime,
      item.size,
      r.contentHash,
      r.isPage ? 1 : 0,
      r.isLayout ? 1 : 0,
      r.renderBoundary,
      r.boundaryDirective ?? null,
      JSON.stringify(r.contractSummary)
    );
    const fileRow = selectFileIdStmt.get(r.filePath) as { id: number };
    const fileId = fileRow.id;
    fileIdByPath.set(r.filePath, fileId);
    upsertedFileIds.push(fileId);

    if (!useFullFtsRebuild && !item.isNew) {
      removeFileSymbolsFromFts(fileId);
    }
    clearSymbolsStmt.run(fileId);
    clearEdgesStmt.run(fileId);

    for (const sym of r.symbols) {
      const parentId = sym.parentSymbolUid ? symbolIdByUid.get(sym.parentSymbolUid) ?? null : null;
      const info = insertSymbolStmt.run(
        sym.symbolUid,
        fileId,
        item.pkgId,
        sym.name,
        sym.kind,
        parentId,
        sym.isExported ? 1 : 0,
        sym.isDefault ? 1 : 0,
        sym.signature,
        sym.startOffset,
        sym.endOffset,
        sym.startLine,
        sym.endLine,
        sym.meta ? JSON.stringify(sym.meta) : null
      );
      const rowId = Number(info.lastInsertRowid);
      symbolIdByUid.set(sym.symbolUid, rowId);
      if (!useFullFtsRebuild) {
        insertFtsStmt.run(rowId, sym.name, sym.signature ?? '');
      }
    }
  }

  if (loadAllFilesForEdges) {
    const allFileRows = db.query('SELECT id, path FROM files').all() as Array<{
      id: number;
      path: string;
    }>;
    for (const row of allFileRows) {
      fileIdByPath.set(row.path, row.id);
    }
  }

  for (const item of extractedBatch) {
    const sourceFileId = fileIdByPath.get(item.result.filePath)!;
    for (const edge of item.result.edges) {
      const sourceSymbolId = edge.sourceSymbolUid
        ? symbolIdByUid.get(edge.sourceSymbolUid) ?? null
        : null;
      const targetFileId = edge.targetFilePath
        ? fileIdByPath.get(edge.targetFilePath) ?? null
        : null;
      insertEdgeStmt.run(
        sourceFileId,
        sourceSymbolId,
        targetFileId,
        null,
        edge.targetName,
        edge.edgeKind,
        edge.isDynamic ? 1 : 0,
        edge.confidence,
        edge.lineNumber,
        edge.startOffset,
        edge.endOffset,
        edge.payload ? JSON.stringify(edge.payload) : null
      );
    }
  }

  const isPartialIncrementalEdit =
    !useFullFtsRebuild &&
    deletedFileIds.length === 0 &&
    !extractedBatch.some(
      (item) =>
        item.isNew &&
        item.result.symbols.some(
          (s) => s.kind === 'component' || (s.isExported && /^use[A-Z]/.test(s.name))
        )
    );

  if (isPartialIncrementalEdit) {
    if (upsertedFileIds.length > 0) {
      linkWorkspaceEdges(db, { scopedSourceFileIds: upsertedFileIds });
    }
  } else {
    linkWorkspaceEdges(db);
  }
}

/**
 * Incremental Index Sync for SQLite Schema v3:
 * - Clean git HEAD fast path (zero filesystem walk when working tree is clean).
 * - Scoped package sync with (mtime, size) skip before reading/hashing file bytes.
 * - Atomic SQLite transaction updating packages, files, symbols, symbol_edges, routes, and FTS5.
 */
export async function syncWorkspaceV3(
  workspaceRoot: string,
  options: FastSyncOptions = {}
): Promise<FastSyncStats> {
  const start = performance.now();
  const absRoot = canonicalizePath(workspaceRoot);
  const db = options.db ?? defaultWarmDbPool.get(absRoot, options);

  const allPackages = discoverWorkspacePackages(absRoot);
  const targetPackages = options.packageKey
    ? allPackages.filter((p) => p.packageKey === options.packageKey)
    : allPackages;

  const pkgFingerprint = createHash('sha256')
    .update(JSON.stringify(allPackages.map((p) => [p.packageKey, p.manifestHash])))
    .digest('hex');

  // Level 0: Clean Git HEAD fast-path (only when syncing full workspace and not forced)
  if (!options.force && !options.packageKey) {
    const gitState = computeGitStateFingerprint(absRoot);
    if (
      gitState &&
      getMeta(db, 'git_clean_head') === gitState &&
      getMeta(db, 'packages_fingerprint') === pkgFingerprint
    ) {
      const counts = db
        .query(
          'SELECT (SELECT count(*) FROM files) AS f, (SELECT count(*) FROM symbols) AS s, (SELECT count(*) FROM symbol_edges) AS e'
        )
        .get() as { f: number; s: number; e: number };
      return {
        mode: 'git-fast-path',
        packagesSynced: targetPackages.length,
        added: 0,
        modified: 0,
        unchanged: counts.f,
        deleted: 0,
        symbolsIndexed: counts.s,
        edgesIndexed: counts.e,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }
  }

  const supportedExts = defaultPluginRegistry.supportedExtensions();

  const emitProgress = options.onProgress;

  // Upsert discovered packages first
  const pkgIdByKey = new Map<string, number>();
  let deletedPkgCount = 0;
  db.transaction(() => {
    const upsertPkg = db.prepare(`
      INSERT INTO packages(package_key, name, root_path, tsconfig_path, framework, router, exports_json, manifest_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_key) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        tsconfig_path = excluded.tsconfig_path,
        framework = excluded.framework,
        router = excluded.router,
        exports_json = excluded.exports_json,
        manifest_hash = excluded.manifest_hash
    `);
    const selectPkgId = db.prepare('SELECT id FROM packages WHERE package_key = ?');

    for (const pkg of allPackages) {
      upsertPkg.run(
        pkg.packageKey,
        pkg.name,
        pkg.rootPath,
        pkg.tsconfigPath,
        pkg.framework,
        pkg.router,
        JSON.stringify(pkg.exportsMap),
        pkg.manifestHash
      );
      const row = selectPkgId.get(pkg.packageKey) as { id: number };
      pkgIdByKey.set(pkg.packageKey, row.id);
    }

    // Remove packages that no longer exist on disk (only on full workspace sync)
    if (!options.packageKey) {
      const validKeys = new Set(allPackages.map((p) => p.packageKey));
      const existingPkgs = db.query('SELECT id, package_key FROM packages').all() as Array<{
        id: number;
        package_key: string;
      }>;
      const delPkg = db.prepare('DELETE FROM packages WHERE id = ?');
      for (const row of existingPkgs) {
        if (!validKeys.has(row.package_key)) {
          delPkg.run(row.id);
          deletedPkgCount++;
        }
      }
    }
  }).immediate();

  // Load existing file metadata for target packages
  const existingFiles = new Map<
    string,
    { id: number; mtime: number; size: number; contentHash: string; packageId: number }
  >();
  for (const pkg of targetPackages) {
    const pkgId = pkgIdByKey.get(pkg.packageKey)!;
    const rows = db
      .query('SELECT id, path, mtime, size, content_hash FROM files WHERE package_id = ?')
      .all(pkgId) as Array<{
      id: number;
      path: string;
      mtime: number;
      size: number;
      content_hash: string;
    }>;
    for (const r of rows) {
      existingFiles.set(r.path, {
        id: r.id,
        mtime: r.mtime,
        size: r.size,
        contentHash: r.content_hash,
        packageId: pkgId,
      });
    }
  }

  // Stage 1: Scan disk scoped to targetPackages with (mtime, size) fast skip
  const scanStart = performance.now();
  emitProgress?.({ stage: 'scan', status: 'start' });

  const seenOnDisk = new Set<string>();
  const candidateFiles: Array<{ filePath: string; pkg: WorkspacePackageInfo }> = [];
  const toExtract: Array<{
    filePath: string;
    pkg: WorkspacePackageInfo;
    mtime: number;
    size: number;
    isNew: boolean;
  }> = [];
  let unchanged = 0;

  for (const pkg of targetPackages) {
    const nestedChildRoots =
      allPackages.length > 1
        ? allPackages
            .filter(
              (other) =>
                other.packageKey !== pkg.packageKey &&
                other.rootPath.length > pkg.rootPath.length &&
                (other.rootPath.startsWith(pkg.rootPath + '/') ||
                  other.rootPath.startsWith(pkg.rootPath + '\\'))
            )
            .map((other) => other.rootPath)
        : [];

    for await (const rawPath of iterateFiles(pkg.rootPath, { ignoreRoot: absRoot })) {
      const ext = extname(rawPath).toLowerCase();
      if (!supportedExts.has(ext)) continue;
      const filePath = canonicalizePath(rawPath);
      // Skip files owned by a nested sub-package (O(1) when no nested sub-packages exist)
      if (nestedChildRoots.length > 0) {
        let ownedByChild = false;
        for (const childRoot of nestedChildRoots) {
          if (
            filePath === childRoot ||
            filePath.startsWith(childRoot + '/') ||
            filePath.startsWith(childRoot + '\\')
          ) {
            ownedByChild = true;
            break;
          }
        }
        if (ownedByChild) continue;
      }

      seenOnDisk.add(filePath);
      candidateFiles.push({ filePath, pkg });
    }
  }

  const IO_BATCH_SIZE = 32;
  for (let i = 0; i < candidateFiles.length; i += IO_BATCH_SIZE) {
    const batch = candidateFiles.slice(i, i + IO_BATCH_SIZE);
    const stats = await Promise.all(batch.map((c) => fs.stat(c.filePath)));
    for (let j = 0; j < batch.length; j++) {
      const { filePath, pkg } = batch[j]!;
      const st = stats[j]!;
      const mtime = Math.trunc(st.mtimeMs);
      const size = st.size;
      const prev = existingFiles.get(filePath);

      if (!options.force && prev && prev.mtime === mtime && prev.size === size) {
        unchanged++;
        continue;
      }

      toExtract.push({
        filePath,
        pkg,
        mtime,
        size,
        isNew: !prev,
      });
    }
  }

  // Identify deleted files in targetPackages
  const deletedFileIds: number[] = [];
  for (const [path, info] of existingFiles.entries()) {
    if (!seenOnDisk.has(path)) {
      deletedFileIds.push(info.id);
    }
  }

  // Build in-memory knownFiles set for O(1) import resolution without disk statSync syscalls
  let knownFiles: Set<string>;
  if (!options.packageKey) {
    knownFiles = seenOnDisk;
  } else {
    knownFiles = new Set(seenOnDisk);
    const otherRows = db.query('SELECT path FROM files').all() as Array<{ path: string }>;
    for (const r of otherRows) knownFiles.add(r.path);
  }

  emitProgress?.({
    stage: 'scan',
    status: 'done',
    completed: seenOnDisk.size,
    total: seenOnDisk.size,
    detail: `${seenOnDisk.size.toLocaleString()} found`,
    durationMs: Math.round(performance.now() - scanStart),
  });

  // Stage 2: Parse & extract symbols/edges for added / modified files in memory
  const parseStart = performance.now();
  emitProgress?.({ stage: 'parse', status: 'start', completed: 0, total: toExtract.length });

  const extractedBatch: Array<{
    result: Tier1ExtractionResult;
    pkgId: number;
    mtime: number;
    size: number;
    isNew: boolean;
  }> = [];

  let added = 0;
  let modified = 0;
  let parsedCount = 0;
  let totalExtractedEdges = 0;
  let workersUsed = 1;

  const parallelThreshold = options.parallelThreshold ?? DEFAULT_PARALLEL_PARSE_THRESHOLD;
  const parallelResult =
    toExtract.length >= parallelThreshold
      ? await parseFilesInWorkerPool({
          items: toExtract.map((item) => {
            const prev = existingFiles.get(item.filePath);
            return {
              filePath: item.filePath,
              pkgKey: item.pkg.packageKey,
              mtime: item.mtime,
              size: item.size,
              isNew: item.isNew,
              prevId: prev?.id,
              prevContentHash: prev?.contentHash,
            };
          }),
          allPackages,
          knownFiles,
          force: Boolean(options.force),
          maxWorkers: options.maxWorkers,
          onProgress: (completed, total) => {
            emitProgress?.({ stage: 'parse', status: 'progress', completed, total });
          },
        })
      : null;

  if (parallelResult) {
    workersUsed = parallelResult.workersUsed;
    parsedCount = parallelResult.parsedCount;

    if (parallelResult.mtimeOnlyUpdates.length > 0) {
      db.transaction(() => {
        const updStmt = db.prepare('UPDATE files SET mtime = ?, size = ? WHERE id = ?');
        for (const upd of parallelResult.mtimeOnlyUpdates) {
          updStmt.run(upd.mtime, upd.size, upd.id);
        }
      }).immediate();
      unchanged += parallelResult.mtimeOnlyUpdates.length;
    }

    for (const item of parallelResult.extracted) {
      if (item.isNew) added++;
      else modified++;
      totalExtractedEdges += item.result.edges.length;
      extractedBatch.push({
        result: item.result,
        pkgId: pkgIdByKey.get(item.pkgKey)!,
        mtime: item.mtime,
        size: item.size,
        isNew: item.isNew,
      });
    }
  } else {
    const importCache = new Map<string, string | undefined>();

    for (let i = 0; i < toExtract.length; i += IO_BATCH_SIZE) {
      const batch = toExtract.slice(i, i + IO_BATCH_SIZE);
      const contents = await Promise.all(batch.map((item) => fs.readFile(item.filePath, 'utf8')));
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const content = contents[j]!;
        const contentHash = createHash('sha256').update(content).digest('hex');
        const prev = existingFiles.get(item.filePath);

        // Content hash identical despite mtime touch -> update mtime only, skip re-extract
        if (!options.force && prev && prev.contentHash === contentHash) {
          db.run('UPDATE files SET mtime = ?, size = ? WHERE id = ?', [item.mtime, item.size, prev.id]);
          unchanged++;
          parsedCount++;
          continue;
        }

        const extracted = extractTier1File(
          item.filePath,
          content,
          item.pkg,
          allPackages,
          contentHash,
          importCache,
          knownFiles
        );
        parsedCount++;
        if (!extracted) continue;

        if (item.isNew) added++;
        else modified++;
        totalExtractedEdges += extracted.edges.length;

        extractedBatch.push({
          result: extracted,
          pkgId: pkgIdByKey.get(item.pkg.packageKey)!,
          mtime: item.mtime,
          size: item.size,
          isNew: item.isNew,
        });
      }
      emitProgress?.({
        stage: 'parse',
        status: 'progress',
        completed: parsedCount,
        total: toExtract.length,
      });
    }
  }

  emitProgress?.({
    stage: 'parse',
    status: 'done',
    completed: parsedCount,
    total: toExtract.length,
    detail: 'done',
    durationMs: Math.round(performance.now() - parseStart),
  });

  // Stage 3: Resolve routes per package when files changed or initial sync
  const resolveStart = performance.now();
  emitProgress?.({ stage: 'resolve', status: 'start' });

  const routesByPkg = new Map<number, Awaited<ReturnType<typeof scanRoutes>>>();
  let totalRoutesResolved = 0;
  if (added > 0 || modified > 0 || deletedFileIds.length > 0 || options.force) {
    for (const pkg of targetPackages) {
      if (pkg.router && pkg.router !== 'none') {
        try {
          const manifest = await scanRoutes({ targetPath: pkg.rootPath });
          routesByPkg.set(pkgIdByKey.get(pkg.packageKey)!, manifest);
          totalRoutesResolved += manifest.routes.length;
        } catch {
          // non-fatal route scan failure
        }
      }
    }
  }

  emitProgress?.({
    stage: 'resolve',
    status: 'done',
    detail: `${totalExtractedEdges.toLocaleString()} edges, ${totalRoutesResolved} routes`,
    durationMs: Math.round(performance.now() - resolveStart),
  });

  // Stage 4: Commit everything atomically in a single SQLite transaction
  const commitStart = performance.now();
  emitProgress?.({ stage: 'commit', status: 'start' });

  const useFullFtsRebuild =
    Boolean(options.force) ||
    existingFiles.size === 0 ||
    deletedPkgCount > 0 ||
    extractedBatch.length > existingFiles.size / 2;

  db.transaction(() => {
    const fileIdByPath = new Map<string, number>();
    persistSyncBatch(db, {
      deletedFileIds,
      extractedBatch,
      fileIdByPath,
      useFullFtsRebuild,
      loadAllFilesForEdges: true,
    });

    // Update routes per package
    const clearPkgRoutesStmt = db.prepare('DELETE FROM routes WHERE package_id = ?');
    const insertRouteStmt = db.prepare(`
      INSERT OR REPLACE INTO routes(package_id, url_path, file_id, route_type, params_json, handlers_json, layout_chain_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [pkgId, manifest] of routesByPkg.entries()) {
      clearPkgRoutesStmt.run(pkgId);
      for (const route of manifest.routes) {
        const canonicalFile = canonicalizePath(route.filePath);
        const fileId = fileIdByPath.get(canonicalFile);
        if (!fileId) continue;
        insertRouteStmt.run(
          pkgId,
          route.path,
          fileId,
          route.type ?? 'page',
          route.params ? JSON.stringify(route.params) : null,
          route.handlers ? JSON.stringify(route.handlers) : null,
          route.layouts ? JSON.stringify(route.layouts) : null
        );
      }
    }

    // Full FTS5 rebuild only on bulk/initial sync or package deletion; incremental updates already applied above
    if (useFullFtsRebuild && (extractedBatch.length > 0 || deletedFileIds.length > 0 || deletedPkgCount > 0)) {
      db.run("INSERT INTO symbols_fts(symbols_fts) VALUES ('rebuild')");
    }

    setMeta(db, 'packages_fingerprint', pkgFingerprint);
    if (!options.packageKey) {
      const gitState = computeGitStateFingerprint(absRoot);
      if (gitState) setMeta(db, 'git_clean_head', gitState);
      else db.run("DELETE FROM meta WHERE key = 'git_clean_head'");
    }
  }).immediate();

  emitProgress?.({
    stage: 'commit',
    status: 'done',
    detail: 'done',
    durationMs: Math.round(performance.now() - commitStart),
  });

  const totals = db
    .query('SELECT (SELECT count(*) FROM symbols) AS s, (SELECT count(*) FROM symbol_edges) AS e')
    .get() as { s: number; e: number };

  return {
    mode: options.force || existingFiles.size === 0 ? 'full' : 'incremental',
    packagesSynced: targetPackages.length,
    added,
    modified,
    unchanged,
    deleted: deletedFileIds.length,
    symbolsIndexed: totals.s,
    edgesIndexed: totals.e,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    workersUsed,
  };
}

export interface DirtySyncFileCache {
  fileIdByPath: Map<string, number>;
  knownFiles: Set<string>;
}

/**
 * O(|dirtyPaths|) targeted incremental sync driven by the MCP file watcher.
 * Updates only the specified changed/added/deleted files and applies incremental FTS5 updates
 * without walking the workspace directory tree.
 */
export async function syncDirtyFilesV3(
  workspaceRoot: string,
  dirtyPaths: readonly string[],
  options: FastSyncOptions = {},
  fileCache?: DirtySyncFileCache
): Promise<FastSyncStats> {
  const start = performance.now();
  const absRoot = canonicalizePath(workspaceRoot);
  const db = options.db ?? defaultWarmDbPool.get(absRoot, options);

  const allPackages = discoverWorkspacePackages(absRoot);
  const pkgRows = db.query('SELECT id, package_key FROM packages').all() as Array<{
    id: number;
    package_key: string;
  }>;
  const pkgIdByKey = new Map<string, number>();
  for (const r of pkgRows) pkgIdByKey.set(r.package_key, r.id);

  // If workspace packages aren't initialized in DB yet, fall back to full sync
  for (const pkg of allPackages) {
    if (!pkgIdByKey.has(pkg.packageKey)) {
      return syncWorkspaceV3(absRoot, options);
    }
  }

  const supportedExts = defaultPluginRegistry.supportedExtensions();
  let knownFiles: Set<string>;
  let fileIdByPath: Map<string, number>;
  if (fileCache) {
    knownFiles = fileCache.knownFiles;
    fileIdByPath = fileCache.fileIdByPath;
  } else {
    knownFiles = new Set<string>();
    fileIdByPath = new Map<string, number>();
    const allFileRows = db.query('SELECT id, path FROM files').all() as Array<{
      id: number;
      path: string;
    }>;
    for (const r of allFileRows) {
      knownFiles.add(r.path);
      fileIdByPath.set(r.path, r.id);
    }
  }

  const uniqueDirty = new Set<string>();
  for (const raw of dirtyPaths) {
    const ext = extname(raw).toLowerCase();
    if (!supportedExts.has(ext)) continue;
    uniqueDirty.add(canonicalizePath(raw));
  }

  const selectFileMeta = db.prepare(
    'SELECT id, mtime, size, content_hash FROM files WHERE path = ?'
  );

  const deletedFileIds: number[] = [];
  const toParse: Array<{
    filePath: string;
    pkg: WorkspacePackageInfo;
    pkgId: number;
    mtime: number;
    size: number;
    prev?: { id: number; mtime: number; size: number; content_hash: string };
  }> = [];
  let unchanged = 0;

  for (const filePath of uniqueDirty) {
    const owner = matchOwningPackage(filePath, allPackages);
    if (!owner) continue;
    const pkgId = pkgIdByKey.get(owner.packageKey);
    if (pkgId === undefined) continue;

    const prev = (selectFileMeta.get(filePath) as
      | { id: number; mtime: number; size: number; content_hash: string }
      | null) ?? undefined;

    let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      st = await fs.stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (prev) {
          deletedFileIds.push(prev.id);
          knownFiles.delete(filePath);
          fileIdByPath.delete(filePath);
        }
        continue;
      }
      throw err;
    }

    if (!st.isFile()) continue;
    knownFiles.add(filePath);

    const mtime = Math.trunc(st.mtimeMs);
    const size = st.size;
    if (!options.force && prev && prev.mtime === mtime && prev.size === size) {
      unchanged++;
      continue;
    }

    toParse.push({ filePath, pkg: owner, pkgId, mtime, size, prev });
  }

  const importCache = new Map<string, string | undefined>();
  const extractedBatch: Array<{
    result: Tier1ExtractionResult;
    pkgId: number;
    mtime: number;
    size: number;
    isNew: boolean;
  }> = [];
  let added = 0;
  let modified = 0;

  for (const item of toParse) {
    let content: string;
    try {
      content = await fs.readFile(item.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (item.prev) {
          deletedFileIds.push(item.prev.id);
          knownFiles.delete(item.filePath);
          fileIdByPath.delete(item.filePath);
        }
        continue;
      }
      throw err;
    }

    const contentHash = createHash('sha256').update(content).digest('hex');
    if (!options.force && item.prev && item.prev.content_hash === contentHash) {
      db.run('UPDATE files SET mtime = ?, size = ? WHERE id = ?', [
        item.mtime,
        item.size,
        item.prev.id,
      ]);
      unchanged++;
      continue;
    }

    const extracted = extractTier1File(
      item.filePath,
      content,
      item.pkg,
      allPackages,
      contentHash,
      importCache,
      knownFiles
    );
    if (!extracted) continue;

    if (!item.prev) added++;
    else modified++;

    extractedBatch.push({
      result: extracted,
      pkgId: item.pkgId,
      mtime: item.mtime,
      size: item.size,
      isNew: !item.prev,
    });
  }

  if (extractedBatch.length > 0 || deletedFileIds.length > 0) {
    db.transaction(() => {
      persistSyncBatch(db, {
        deletedFileIds,
        extractedBatch,
        fileIdByPath,
        useFullFtsRebuild: false,
        loadAllFilesForEdges: false,
      });

      db.run("DELETE FROM meta WHERE key = 'git_clean_head'");
    }).immediate();
  }

  const totals = db
    .query('SELECT (SELECT count(*) FROM symbols) AS s, (SELECT count(*) FROM symbol_edges) AS e')
    .get() as { s: number; e: number };

  return {
    mode: 'watcher-dirty',
    packagesSynced: allPackages.length,
    added,
    modified,
    unchanged,
    deleted: deletedFileIds.length,
    symbolsIndexed: totals.s,
    edgesIndexed: totals.e,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    workersUsed: 1,
  };
}
