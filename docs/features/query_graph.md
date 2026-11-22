# `query_graph`

Unified relationship, dataflow, and impact query engine across files and workspace packages. Uses SQLite candidate filtering followed by scoped TypeScript Language Service verification, grouping multi-package results by `package_key`.

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `query` | `'definition' \| 'references' \| 'call_hierarchy' \| 'component_tree' \| 'state_flow' \| 'impact'` *(required)* | — | Graph query kind. |
| `target` | `{ symbol_id?, file?, symbol?, member?, line?, column? }` *(required)* | — | Target symbol, file, prop/event member, or position. |
| `direction` | `'up' \| 'down' \| 'both'` | `'up'` | Traversal direction for `call_hierarchy` and `component_tree`. |
| `scope` | `{ packages?: string[], max_depth?: number }` | `max_depth: 4` | Restricts traversal/verification to selected monorepo packages and depth. |
| `limit` | `integer` (`1..500`) | `30` | Maximum items returned per page. |
| `cursor` | `string` | — | Deterministic pagination cursor (`o_<offset>`) returned by a previous call. |
| `root` | `string` | session root | Workspace root directory. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation (`text` or structured `json`). |
| `max_bytes` | `integer` (`>= 512`) | `16384` | Maximum UTF-8 response byte budget. Increase when retrying after `BUDGET_RESPONSE_TOO_LARGE`. |

## Query Modes

- **`definition`**: Exact *Go to Definition* across files, barrel re-exports, monorepo `package.json#exports`, and Nuxt `.nuxt/imports.d.ts`.
- **`references`**: Exact *Find All References* across `.ts`, `.tsx`, `.vue`, `.svelte`, and `.astro` with original SFC line/column remapping, supplemented with indexed SQLite graph edges (`calls`, `renders`, `reads_state`, `writes_state`) to capture Nuxt auto-imports even when `.nuxt/imports.d.ts` has not been generated.
- **`call_hierarchy`**: Callers (`up`) and callees (`down`) for functions, composables, event listeners, and outbound HTTP calls.
- **`component_tree`**: Upward consumer blast radius (`up`) or downward rendered tree (`down`) across packages, traversing transparently through barrel re-export files.
- **`state_flow`**: Readers, writers, watchers, and context providers/consumers for Pinia stores (`use*Store`), Nuxt `useState()`, React Context (`createContext` / `Provider` / `useContext`), and Vue `provide` / `inject` (including local state variable alias resolution via `$.stateVar`).
- **`impact`**: Verified consumer and refactor sites for a component, prop, event, slot, or symbol—paired with explicit `OMISSIONS` for dynamic spreads (`v-bind`, `{...props}`).

## Performance & Traversal Bounds

- **Paginate Before File I/O (`RawLocationDescriptor`)**: `state_flow`, `references`, `call_hierarchy`, and `impact` collect lightweight in-memory `RawLocationDescriptor` records, compute the full cross-package `summaryByPackage` in memory without reading disk, run `paginateItems`, and read file contents (`toLocationItem`) only for the $P_{\text{page}}$ items on the returned page (`O(M metadata + P_page · L_avg)`). When `content_hash` is present in SQLite, `sourceRef` hashes use `shortHashFromFull(content_hash)` directly without re-hashing file bytes.
- **Single-SQL Batch CTE for `impact`**: Resolves transitive component consumers (up to 3 hops across `imports`, `reexports`, and `renders`, including unlinked auto-imports) and joins `renders` edges, file metadata, and `content_hash` in a single SQLite recursive CTE (`O(1 SQL batch + P_page · L_avg)`). `DYNAMIC_SPREAD` omissions are built directly from indexed line numbers and content hashes with zero disk reads during candidate filtering.
- **`component_tree` Bounded DAG Expansion (`O(min(V + E, 500))`)**: Expands each DAG node at most once across the tree (preventing exponential `O(b^d)` blowup on shared components) with per-request `getFileInfo` caching and a 500-node cap (`COMPONENT_TREE_TRUNCATED` diagnostic when reached).
