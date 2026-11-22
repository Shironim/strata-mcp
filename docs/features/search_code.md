# `search_code`

In-process code discovery with no external binary dependencies. Returns `symbolId` and hash-verified `sourceRef` handles ready to pass to `inspect_file`, `query_graph`, or `read_slice`.

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `query` | `string` *(required)* | — | Symbol name, component name, prop/event name, or literal text. |
| `kind` | `'symbol' \| 'component_usage' \| 'prop_usage' \| 'text'` | `'symbol'` | Search mode. |
| `symbol_kinds` | `string[]` | — | Optional filter for `kind: "symbol"` (e.g. `['component', 'store', 'composable', 'function']`). |
| `package` | `string` | — | Restrict search to one monorepo `package_key`. |
| `path_prefix` | `string` | — | Optional relative directory prefix filter. |
| `limit` | `integer` (`1..500`) | `30` | Maximum matches returned per page. |
| `cursor` | `string` | — | Deterministic pagination cursor (`o_<offset>`) returned by a previous call. |
| `root` | `string` | session root | Workspace root directory. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation (`text` or structured `json`). |
| `max_bytes` | `integer` (`>= 512`) | `16384` | Maximum UTF-8 response byte budget. Increase when retrying after `BUDGET_RESPONSE_TOO_LARGE`. |

## Search Modes

- **`symbol`**: Workspace-wide symbol search via SQLite `symbols_fts` (FTS5) ordered by `bm25(symbols_fts)`. Paginates raw SQLite rows before mapping DTOs and formatting `sourceRef` handles (`O(M metadata + P_page)`).
- **`component_usage`**: Finds all template/JSX render sites of a component across packages. Filters `target_name` directly in SQL (case-insensitive, including kebab-case → PascalCase normalization) and paginates before reading file snippets (`O(log E + P_page · L_avg)`).
- **`prop_usage`**: Finds all component usages passing a specific prop or event listener. Uses `idx_edges_kind` (`edge_kind = 'renders'`) with parameterized SQL pre-filtering (`AND e.payload_json LIKE '%' || ? || '%'`) before verifying exact prop/event names via `JSON.parse`, and paginates before reading file snippets (`O(M_cand + P_page · L_avg)`).
- **`text`**: Scoped literal text search over indexed frontend files (capped at 500 matches) using single-pass `lineStarts` per matching file (`O(L + M log L)`).
