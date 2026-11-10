# storage-and-delta-sync — SSOT graph.db Database & Delta Sync Engine

**Status:** Single Source of Truth (SSOT)  
**Feature Owner:** Storage & Synchronization Engine (`src/engine/storage/`)  
**Last Updated:** 2026-11-11  

---

## 1. Purpose & Business Requirements

Medium to large frontend applications can easily span hundreds or thousands of component files:
* **Performance Challenges:**
  * Re-parsing complete file ASTs on every tool invocation takes multiple seconds (severely degrading interactive LLM response times).
  * Retaining complete source text in memory wastes RAM.
  * Naive caching serves stale data whenever a shared type file (`types.ts`) or barrel re-export (`index.ts`) changes.
* **The Storage & Delta Sync Solution:**
  Provides a high-speed embedded relational database **SQLite (`.strata/graph.db`)** operating in **WAL (Write-Ahead Logging)** mode, coupled with a two-tier **Incremental Delta-Sync** algorithm (mtime + streaming SHA-256) and *transitive reverse invalidation*.

---

## 2. SQLite Database Architecture (`.strata/graph.db`)

The database is initialized automatically during `strata init`:
* File location: `<workspace_root>/.strata/graph.db`
* Isolated from Git: The `.strata` directory is automatically scaffolded with a `.gitignore` containing `*`.
* **High-Performance PRAGMAs:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 15000;
  PRAGMA cache_size = -8192;
  PRAGMA temp_store = FILE;
  ```

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
| **`meta`** | `key`, `value` | Internal metadata: `cache_version`, `config_fingerprint`, `sync_generation`. |

---

## 4. Incremental Delta-Sync Algorithm

Whenever a Strata tool is called, `syncWorkspace()` runs automatically (*Just-In-Time Preflight*):

```
[Agent Invokes a Strata Tool]
               │
               ▼
    [JIT Preflight Check] ──► syncWorkspace()
               │
               ├── 1. Fast Fingerprint (Check filesystem mtime & size)
               │      └── If modified: Compute streaming SHA-256 hash
               │
               ├── 2. Change Classification (Compare against graph.db)
               │      ├── UNCHANGED  ──► Skip (0 ms)
               │      ├── ADDED      ──► Parse AST of new file only
               │      ├── MODIFIED   ──► Re-parse affected file & downstream dependents
               │      └── DELETED    ──► Remove via ON DELETE CASCADE
               │
               └── 3. Transitive Invalidation (Check file_dependencies)
                      └── If types.ts / index.ts changed, re-parse dependent consumers
               │
               ▼
[Execute Tool Query with 100% Fresh Data (< 50ms)]
```

### A. Two-Tier Verification (*Stat + Streaming Hash*)
1. **Tier 1 (In-Memory Fast Check):** Compares `mtimeMs` and `size`. If identical to cached values, the file is skipped immediately (*zero overhead*).
2. **Tier 2 (Cryptographic Hash):** If `mtime` changed, Strata reads a 64 KB streaming buffer to calculate the SHA-256 hash. If identical (e.g., re-saved without text edits), AST parsing is bypassed.

### B. Clean Deletion via `ON DELETE CASCADE`
All child tables (`components`, `edges`, `state_deps`, `routes`, `file_dependencies`) specify foreign key constraints:
```sql
REFERENCES files(id) ON DELETE CASCADE
```
When a file is removed from the workspace, deleting 1 row from `files` **automatically cascades and purges all associated edges, state dependencies, and tree hierarchies** without leaving orphan records.

### C. Transitive Invalidation (Types & Barrel Files)
If a developer alters `types.ts` (imported by `UserProfile.vue`):
1. The hash of `types.ts` is tracked in `file_dependencies`.
2. When `types.ts` changes, Strata flags a hash mismatch on `UserProfile.vue`'s dependencies.
3. `UserProfile.vue` is automatically marked **`stale`** and re-parsed so its prop contracts remain current.

### D. Global Configuration Tracking (`config_fingerprint`)
If `tsconfig.json`, `jsconfig.json`, or path aliases change:
* Strata detects a differing `config_fingerprint` hash.
* Triggers an automatic, clean full rebuild to guarantee consistent alias resolution across the entire graph.

---

## 5. Data Security & Crash Resilience

1. **Staged Sync via Temp Tables:**
   Synchronization mutations stage into SQLite `TEMP TABLE` structures (`temp.sync_files`, `temp.sync_verify`). If a process terminates abruptly, the main database remains uncorrupted (*anti-corruption*).
2. **WAL Concurrency & Busy Timeout:**
   * Reader queries do not block writer synchronizations.
   * A 15-second busy timeout (`busy_timeout = 15000`) with auto-retry handles transient lock contention cleanly.

---

## 6. Code Implementation References

* **Database Schema & Registry:** [`src/engine/storage/schema.ts`](../../src/engine/storage/schema.ts)
* **Delta Sync Engine:** [`src/engine/storage/delta-sync.ts`](../../src/engine/storage/delta-sync.ts)
* **Staged Sync Algorithm:** [`src/engine/storage/staged-sync.ts`](../../src/engine/storage/staged-sync.ts)
* **State Storage Queries:** [`src/engine/storage/state-storage.ts`](../../src/engine/storage/state-storage.ts)
