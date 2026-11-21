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
| `cursor` | `string` | — | Pagination cursor. |
| `root` | `string` | session root | Workspace root directory. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation. |

## Search Modes

- **`symbol`**: Instant workspace-wide symbol search via SQLite `symbols_fts` (FTS5).
- **`component_usage`**: Finds all template/JSX render sites of a component across packages.
- **`prop_usage`**: Finds all component usages passing a specific prop or event listener.
- **`text`**: Scoped literal text search over indexed frontend files.
