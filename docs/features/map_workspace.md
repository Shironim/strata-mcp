# `map_workspace`

Orient inside a single-repo frontend app, fullstack JS/TS project, monolith with separate frontend subdirectories, or monorepo before reading individual files. Powered by the SQLite index (`<30ms` warm).

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `root` | `string` | session root | Workspace root directory. |
| `view` | `'overview' \| 'packages' \| 'routes' \| 'files' \| 'health'` | `'overview'` | Orientation view to return. |
| `package` | `string` | — | Restrict results to one monorepo `package_key` (e.g. `apps/web`, `packages/ui`). |
| `path_prefix` | `string` | — | Optional relative directory prefix filter (for `view: "files"`). |
| `limit` | `integer` (`1..500`) | `100` | Maximum items returned per page. |
| `cursor` | `string` | — | Deterministic pagination cursor (`o_<offset>`) returned by a previous call. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation (`text` or structured `json`). |
| `max_bytes` | `integer` (`>= 512`) | `16384` | Maximum UTF-8 response byte budget. Increase when retrying after `BUDGET_RESPONSE_TOO_LARGE`. |

## Views

- **`overview` / `packages`**: Discovered monorepo packages (`pnpm-workspace.yaml`, `package.json#workspaces`, or standalone root), framework and router per package, file/symbol/route totals, and `exports`. In MCP clients that support MCP Apps, calling `map_workspace` also attaches the interactive **Strata Explorer** UI (`ui://strata/explorer.html`).
- **`routes`**: Package-partitioned page and API route manifest (URL path → file → route type, params, layouts, and render boundary). Paginates SQLite rows before parsing JSON route metadata (`O(M metadata + P_page)`).
- **`files`**: Bounded file inventory per package without reading file bodies. Paginates SQLite rows before building file DTOs (`O(M metadata + P_page)`).
- **`health`**: Candidate unused non-page/non-layout components (excluding framework root entrypoints such as `app.vue` and `error.vue`) with static-analysis diagnostics.
