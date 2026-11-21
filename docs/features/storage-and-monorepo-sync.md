# SQLite Index Storage (`Schema v3`) & Incremental Sync

Strata MCP stores its persistent structural and symbol graph in `<workspaceRoot>/.strata/graph.db` using SQLite (`WAL` mode, `PRAGMA user_version = 3`).

## Schema `v3` Overview

- **`packages`**: Monorepo package partitions discovered via `pnpm-workspace.yaml`, `package.json#workspaces`, or standalone root (`package_key`, `name`, `root_path`, `tsconfig_path`, `framework`, `router`, `exports_json`, `manifest_hash`).
- **`files`**: Tracked frontend source files per `package_id` with `mtime`, `size`, `content_hash`, `is_page`, `is_layout`, `render_boundary`, and cached `contract_json`.
- **`symbols`**: First-class symbol table (`component`, `function`, `class`, `method`, `composable`, `store`, `context`, `type`, `interface`, `enum`, `variable`, `prop`, `emit`, `slot`, `model`) with deterministic `symbol_uid` and exact byte/line spans.
- **`symbol_edges`**: Unified relationship table (`imports`, `reexports`, `renders`, `calls`, `reads_state`, `writes_state`, `watches_state`, `passes_prop`, `listens_event`, `provides_context`, `consumes_context`, `extends_type`, `outbound_http`, `submits_form`).
- **`routes`**: Package-partitioned route manifest.
- **`file_dependencies`**: Dependency invalidation links (barrel files, config manifests).
- **`symbols_fts`**: SQLite FTS5 virtual table for instant workspace-wide symbol discovery.

## Incremental Sync & Warm Connection Lifecycle

1. **Level 0 — Clean Git `HEAD` Fast Path**: When `git status --porcelain` is empty and `HEAD` + package manifests match the last sync, sync returns in `<15ms` without walking the filesystem.
2. **Level 1 — Scoped Package Sync + `(mtime, size)` Skip**: Syncs can target a single `package_key`, skipping file reads/hashing whenever `(mtime, size)` are unchanged.
3. **Level 2 — Atomic Transaction + FTS5 Rebuild**: All file/symbol/edge/route updates commit in a single SQLite transaction.
4. **Warm Connection Pool**: `WarmDatabasePool` keeps connections warm across MCP tool calls and closes them on server shutdown or idle TTL expiry.
