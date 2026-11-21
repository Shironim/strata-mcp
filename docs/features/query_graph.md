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
| `cursor` | `string` | — | Pagination cursor. |
| `root` | `string` | session root | Workspace root directory. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation. |

## Query Modes

- **`definition`**: Exact *Go to Definition* across files, barrel re-exports, monorepo `package.json#exports`, and Nuxt `.nuxt/imports.d.ts`.
- **`references`**: Exact *Find All References* across `.ts`, `.tsx`, `.vue`, `.svelte`, and `.astro` with original SFC line/column remapping.
- **`call_hierarchy`**: Callers (`up`) and callees (`down`) for functions, composables, and outbound HTTP calls.
- **`component_tree`**: Upward consumer blast radius (`up`) or downward rendered tree (`down`) across packages.
- **`state_flow`**: Readers, writers, and watchers for stores, composables, and reactive state identifiers.
- **`impact`**: Verified consumer/refactor sites for a component, prop, event, slot, or symbol—always paired with explicit `OMISSIONS` for dynamic spreads (`v-bind`, `{...props}`).
