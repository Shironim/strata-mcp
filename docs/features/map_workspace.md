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
| `cursor` | `string` | — | Deterministic pagination cursor (`o_<offset>`). |
| `format` | `'text' \| 'json'` | `'text'` | Output representation. |

## Views

- **`overview` / `packages`**: Discovered monorepo packages (`pnpm-workspace.yaml`, `package.json#workspaces`, or single root), framework & router per package, file/symbol/route totals, and `exports`.
- **`routes`**: Package-partitioned route manifest (URL path → page file → route type & render boundary).
- **`files`**: Bounded file inventory per package without reading file bodies.
- **`health`**: Static candidate unused non-page/non-layout components with explicit confidence and static-analysis diagnostics.
