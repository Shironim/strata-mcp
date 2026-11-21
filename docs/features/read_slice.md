# `read_slice`

Read a bounded, hash-verified source code slice after orienting with `map_workspace`, `inspect_file`, `query_graph`, or `search_code`.

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `source_ref` | `string` | — | Hash-verified handle (`ref:<sha8>:<start>-<end>@<path>`) from another tool. |
| `symbol_id` | `string` | — | Stable `symbolId` handle to read its exact declaration body. |
| `path` | `string` | — | File path (used with `symbol`, `block`, or `lines`). |
| `symbol` | `string` | — | Symbol name inside `path`. |
| `block` | `'script' \| 'scriptSetup' \| 'template' \| 'style'` | — | Specific SFC block to read. |
| `lines` | `[number, number]` | — | Explicit 1-based inclusive `[startLine, endLine]` range. |
| `context_lines` | `integer` (`0..20`) | `2` | Extra surrounding context lines. |
| `max_lines` | `integer` (`1..400`) | `80` | Maximum lines returned in one call (emits `SLICE_TRUNCATED` diagnostic if exceeded). |
| `root` | `string` | session root | Workspace root directory. |

## Safety & Freshness Guarantees

- **Stale Reference Detection**: If the file changed on disk after a `source_ref` was issued, `read_slice` returns `[STALE_SOURCE]` instead of returning shifted lines.
- **Workspace Boundary Guard**: Paths escaping `root` (e.g. `../../../etc/passwd`) are rejected with `[WORKSPACE_BOUNDARY_ERROR]`.
