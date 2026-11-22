# SQLite Index Storage (`Schema v3`) & Incremental Sync

Strata MCP stores its persistent structural and symbol graph in `<workspaceRoot>/.strata/graph.db` using SQLite (`WAL` mode, `PRAGMA user_version = 3`).

## Schema `v3` Overview

- **`packages`**: Monorepo package partitions discovered via `pnpm-workspace.yaml`, `package.json#workspaces`, or standalone root (`package_key`, `name`, `root_path`, `tsconfig_path`, `framework`, `router`, `exports_json`, `manifest_hash`).
- **`files`**: Tracked frontend source files per `package_id` with `mtime`, `size`, `content_hash`, `is_page`, `is_layout`, `render_boundary`, and cached `contract_json`.
- **`symbols`**: First-class symbol table (`component`, `function`, `class`, `method`, `composable`, `store`, `context`, `type`, `interface`, `enum`, `variable`, `prop`, `emit`, `slot`, `model`) with deterministic `symbol_uid` and exact byte/line spans.
- **`symbol_edges`**: Unified relationship table (`imports`, `reexports`, `renders`, `calls`, `reads_state`, `writes_state`, `watches_state`, `passes_prop`, `listens_event`, `provides_context`, `consumes_context`, `extends_type`, `outbound_http`, `submits_form`), indexed on `(source_file_id, edge_kind)`, `(target_file_id, edge_kind)`, `(target_symbol_id, edge_kind)`, `(target_name, edge_kind)`, and `(edge_kind)` (`idx_edges_kind`).
- **`routes`**: Package-partitioned route manifest.
- **`file_dependencies`**: Dependency invalidation links (barrel files, config manifests).
- **`symbols_fts`**: SQLite FTS5 virtual table for instant workspace-wide symbol discovery.

## Multi-Stage Sync Pipeline (`syncWorkspaceV3`)

Full and incremental syncs run as 4 explicit stages with an optional `onProgress` hook (used by `strata init` to render live stage progress without leaking timings to stdout):

1. **`scan`**: Discovers workspace packages, walks directories (reading `.gitignore`/`.strataignore` only when present in a directory), batches `fs.stat` (concurrency 32), builds an in-memory `knownFiles` set for `O(1)` import resolution without disk `statSync` syscalls, caches package-name lookups in a `WeakMap` (`packageByNameCache` in `src/engine/v2/workspace-packages.ts`) for `O(1)` workspace package specifier resolution, and uses precomputed `nestedChildRoots` for `O(1)` package ownership checks in standard monorepos.
2. **`parse`**: Extracts Tier-1 symbols and edges using single-pass `lineStarts` (`O(L + E_f log L)`).
   - **Adaptive Parallel CPU Worker Pool** (`src/engine/v2/parse-pool.ts`, `src/engine/v2/parse-worker.ts`, bundled as `dist/engine/v2/parse-worker.js`): Automatically activates when `toExtract.length >= 1000` (configurable via `parallelThreshold`), dispatching balanced chunks across up to `min(cpus - 1, 4)` Bun `Worker` threads with automatic main-thread fallback if workers are unavailable.
3. **`resolve`**: Scans framework routes per changed package.
4. **`commit`**: Commits all `files`, `symbols`, `symbol_edges`, and `routes` updates in a single atomic SQLite transaction (`persistSyncBatch` in `src/engine/v2/fast-sync.ts`).
   - **Incremental FTS5 Updates**: On incremental syncs (not `force`, not initial sync, no deleted packages, and ≤ 50% files changed), updates `symbols_fts` incrementally via FTS5 `'delete'` + `INSERT` (`O(S_chg log S)`); uses bulk `VALUES ('rebuild')` only on initial/forced/majority rebuilds.
   - **Scoped Cross-File Graph Linker** (`linkWorkspaceEdges` in `src/engine/v2/graph-linker.ts`): Resolves unlinked `renders` edges (`target_file_id IS NULL`) against workspace component symbols (supporting Nuxt/Vue global auto-imports, directory-prefixed names, layers, and `Lazy*` prefixes) and links auto-imported `use*` composable `calls`. On partial incremental edits (`!useFullFtsRebuild`, no deleted files, and no newly created file declaring a `component` or exported `use*` composable), `persistSyncBatch` passes `scopedSourceFileIds: upsertedFileIds` (guarded to `<= 500` SQLite bind variables), restricting edge queries to `AND e.source_file_id IN (...)` (`O(|D| · E_d)`) and returning immediately in `O(1)` when the edited files contain no unlinked renders or composable calls.

## Incremental Fast Paths & MCP Runtime (`WorkspaceSyncCoordinator`)

1. **Level 0 — Clean Git `HEAD` Fast Path**: When `git status --porcelain` is empty and `HEAD` + package manifests match the last sync, sync returns in `<15ms` without walking the filesystem.
2. **Level 1 — Scoped Package Sync + `(mtime, size)` Skip**: Syncs can target a single `package_key`, skipping file reads/hashing whenever `(mtime, size)` are unchanged.
3. **MCP Runtime Coordinator** (`src/engine/v2/sync-coordinator.ts`):
   - **Single-Flight Sync Coalescing**: Concurrent tool calls or startup warmup targeting the same workspace/scope share one in-flight sync promise, avoiding duplicate work and SQLite lock contention.
   - **Recursive `fs.watch` Dirty-File Queue**: When the MCP server is running on an initialized workspace, file edits are queued into `dirtyFiles` (ignoring `IGNORED_DIRS`).
     - **`watcher-clean` (`O(1)`)**: If no dirty files were recorded, sync returns immediately (`0ms`) without walking the filesystem or spawning `git`.
     - **`watcher-dirty` (`O(|dirtyFiles| · L + S_chg log S)`)**: Processes only queued files via `syncDirtyFilesV3` using a cached `fileIdByPath`/`knownFiles` map and incremental FTS5 updates.
     - **Automatic Full-Sync Fallback**: Config/ignore edits (`package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `.gitignore`, etc.), bursts exceeding 100 dirty files, or OS watcher errors (e.g. `ENOSPC`) fall back safely to `syncWorkspaceV3`.
   - **Startup Background Warmup**: `startMcpServer()` calls `warmupInBackground(process.cwd())` when `.strata/graph.db` already exists, starting the watcher and coalescing an initial non-blocking sync.
4. **Warm Connection Pool & Shutdown**: `WarmDatabasePool` keeps SQLite connections warm across MCP tool calls; `AnalysisSupervisor.close()` closes all watchers (`defaultSyncCoordinator.closeAll()`), disposes semantic pools, and closes DB handles cleanly.
