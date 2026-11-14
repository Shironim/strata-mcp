# storage-and-delta-sync — SSOT graph.db Database & Delta Sync Engine

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Storage & Synchronization Engine (`src/engine/storage/`)  
**Last Updated:** 2026-11-14

---

## 1. Purpose & Business Requirements

Medium to large frontend applications can easily span hundreds or thousands of component files:
* **Indexing concerns:**
  * Re-parsing every file on each invocation repeats source reads and AST construction even when files are unchanged.
  * Retaining complete source text in memory wastes RAM.
  * Naive caching serves stale data whenever a shared type file (`types.ts`) or barrel re-export (`index.ts`) changes.
* **The Storage & Delta Sync Solution:**
  Uses embedded SQLite (`.strata/graph.db`) with WAL, streaming source hashes, staged parsing, and transitive reverse dependency invalidation. Incremental means parsing an affected set; filesystem scanning and hashing still have a workspace cost.

---

## 2. SQLite Database Architecture (`.strata/graph.db`)

The database is initialized automatically during `strata init`:

* File location: `<workspace_root>/.strata/graph.db`
* Isolated from Git: The `.strata` directory is automatically scaffolded with a `.gitignore` containing `*`.

Ordinary index opens walk up to the nearest existing `.strata` directory and can
reuse an ancestor monorepo index. Explicit creation selects the requested root;
without an existing index or explicit creation, opening fails with `NOT_INDEXED`.
Inventory mapping does not create one. Requested scope and the owning index root
can differ; a scoped query does not imply scoped filesystem work or OS isolation.

* **SQLite PRAGMAs & Schema Checks:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 15000;
  PRAGMA cache_size = -8192;
  PRAGMA temp_store = FILE;
  PRAGMA user_version = 2;
  ```
  * **Warm Connection Fast-Path (`SCHEMA_USER_VERSION = 2`):** On subsequent opens, `initSchema` checks `PRAGMA user_version` and the 7 core tables before skipping redundant schema setup. MCP analyses execute in the server process and close their registered connections after execution.
  * **Supported Indexed Extensions:** `.vue`, `.astro`, `.svelte`, `.tsx`, `.jsx`, `.ts`, `.js`.

---

## 3. Relational Table Schema

```
           ┌──────────────┐
           │    files     │
           └──────┬───────┘
                  │ 1
       ┌──────────┼──────────────┬──────────────┬──────────────┐
       │ *        │ *            │ *            │ *            │ *
┌──────┴──────┐ ┌─┴────────────┐ ┌┴───────────┐ ┌┴───────────┐ ┌┴──────────────────┐
│ components  │ │    edges     │ │ state_deps │ │   routes   │ │ file_dependencies │
└─────────────┘ └──────────────┘ └────────────┘ └────────────┘ └───────────────────┘
```

| Table | Primary Columns | Role & Stored Data |
|---|---|---|
| **`files`** | `id`, `path`, `framework`, `mtime`, `size`, `content_hash`, `is_page`, `is_layout`, `render_boundary` | Master file catalog, content hashes, and hydration rendering boundaries. |
| **`components`** | `id`, `file_id`, `name`, `contract_json` | Public component contracts (props, emits, slots, models) stored as structured JSON. |
| **`edges`** | `id`, `parent_file_id`, `child_file_id`, `import_type`, `is_rendered`, `payload_json` | Graph relation edges: parent renders child, passed props, and context provision. |
| **`state_deps`** | `id`, `file_id`, `kind`, `identifier`, `access_mode`, `line_number`, `usage_snippet`, `accessed_properties` | Reactivity tracking (Pinia/Zustand/Composable), access mode (read/write/watch). |
| **`routes`** | `id`, `url_path`, `file_id`, `type`, `params_json`, `layout_chain_json` | Route URL mapping, dynamic parameters, and wrapping nested layout chains. |
| **`file_dependencies`** | `file_id`, `dependency_path`, `content_hash`, `is_external` | Shared types / barrel file dependencies for cross-file change invalidation. |
| **`meta`** | `key`, `value` | Internal metadata: `cache_version`, `config_fingerprint`, `routes_fingerprint`, `sync_generation`, `index_invalid`. |

---

## 4. Incremental Delta-Sync Algorithm

Indexed tree/state operations and initialized patch planning run a freshness preflight. Source search/inspection and filesystem audits read source directly. Library operations preserve source fallback on uninitialized workspaces where supported.

```
[Agent Invokes a Strata Tool]
               │
               ▼
    [JIT Preflight Check] ──► syncWorkspace()
               │
               ├── 1. Hash source/config inputs into temporary tables
               │
               ├── 2. Change Classification (Compare against graph.db)
               │      ├── UNCHANGED  ──► Skip parsing unless dependencies require it
               │      ├── ADDED      ──► Parse new file and affected consumers
               │      ├── MODIFIED   ──► Re-parse affected file & downstream dependents
               │      └── DELETED    ──► Remove via ON DELETE CASCADE
               │
               └── 3. Transitive Invalidation (Check file_dependencies)
                      └── If types.ts / index.ts changed, re-parse dependent consumers
               │
               ▼
[Publish transaction, then execute the requested query]
```

### A. Scan and publication verification
The initial scan hashes each supported source/config file in 64 KiB chunks. The
second scan may reuse that same attempt's hashes when mtime and size are unchanged;
otherwise it hashes again. Parsing candidates and recorded dependencies are checked
against their staged hashes before publication. These checks do not establish an
atomic snapshot of every filesystem/configuration read.

### B. Effective scope and revision
The effective scope is decided before building the mutation/deletion/impact sets.
If an invalidated index or changed scoped inputs require workspace fallback, all
changes in that effective workspace are classified again, including independent
edits, additions and deletions outside the requested scope. Reverse dependencies
are then traversed from that complete mutation set.

Full rebuild and incremental publication use the same contract/state/dependency/edge
writer. `sync_generation` advances only for changed published inputs/rebuilds or
route manifests; an unchanged preflight retains it. `routes_fingerprint` records the
staged route identity, while `config_fingerprint` includes the engine revision and
captured configuration hashes. Local parser changes without a policy/version bump
still require `strata init` to rebuild.

### C. Clean Deletion via `ON DELETE CASCADE`
All child tables (`components`, `edges`, `state_deps`, `routes`, `file_dependencies`) specify foreign key constraints:
```sql
REFERENCES files(id) ON DELETE CASCADE
```
When a file is removed from the workspace, deleting 1 row from `files` **automatically cascades and purges all associated edges, state dependencies, and tree hierarchies** without leaving orphan records.

### D. Transitive Invalidation (Types & Barrel Files)
If a developer alters `types.ts` (imported by `UserProfile.vue`):
1. The hash of `types.ts` is tracked in `file_dependencies`.
2. When `types.ts` changes, Strata flags a hash mismatch on `UserProfile.vue`'s dependencies.
3. `UserProfile.vue` is automatically marked **`stale`** and re-parsed so its prop contracts remain current.

### E. Global Configuration Tracking (`config_fingerprint`)
If `tsconfig.json`, `jsconfig.json`, or path aliases change:
* Strata detects a differing `config_fingerprint` hash.
* Triggers a full rebuild using the captured configuration. This refreshes supported alias resolution; it does not prove unsupported/dynamic module mappings or one atomic snapshot of all subsequent reads.

---

## 5. Data Security & Crash Resilience

1. **Staged Sync via Temp Tables:**
   Parsing and verification stage into SQLite temporary tables before one publication transaction. Cancellation before publication preserves the previous graph. Parse/read failures invalidate derived data and are reported to callers. This design does not replace SQLite durability guarantees or prove resilience to arbitrary disk/host failures.
2. **WAL Concurrency & Busy Timeout:**
   * WAL permits readers alongside a writer; SQLite locks and publication/checkpoint work can still cause contention.
   * Connections use `busy_timeout = 15000`. Sync retries at most three total attempts for recognized busy/locked or `WORKSPACE_CHANGED` failures, with a short backoff for lock contention. Other failures propagate; retries do not guarantee success or impose a 15-second bound on the entire operation.

---

## 6. Code Implementation References

* **Database Schema & Registry:** [`src/engine/storage/schema.ts`](../../src/engine/storage/schema.ts)
* **Delta Sync Engine:** [`src/engine/storage/delta-sync.ts`](../../src/engine/storage/delta-sync.ts)
* **Staged Sync Algorithm:** [`src/engine/storage/staged-sync.ts`](../../src/engine/storage/staged-sync.ts)
* **State Storage Queries:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)

Regression coverage: `tests/core/analysis-consistency.test.ts` and
`tests/core/retrieval-baseline.test.ts` compare scope fallback and incremental edits
with manual oracles/cold rebuilds. `tests/memory/lifecycle.test.ts` covers failed
refresh and concurrent-generation rejection.
