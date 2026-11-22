# `inspect_file`

Inspect a frontend file's symbol outline, TypeChecker-resolved component contract, render boundary, outbound HTTP boundaries, and imports—**strictly without returning implementation bodies**.

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` *(required)* | — | Absolute or workspace-relative path (`.vue`, `.tsx`, `.jsx`, `.svelte`, `.astro`, `.ts`, `.js`). |
| `root` | `string` | session root | Workspace root directory. |
| `sections` | `Array<'outline' \| 'contract' \| 'boundaries' \| 'imports'>` | `['outline', 'contract', 'boundaries']` | Sections to include. |
| `resolve_types` | `boolean` | `true` | Run the TypeScript `TypeChecker` to expand external prop/emit types and fall back on unresolved 1-hop composable HTTP calls. Set `false` for fast read-only graph inspection. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation (`text` or structured `json`). |
| `max_bytes` | `integer` (`>= 512`) | `16384` | Maximum UTF-8 response byte budget. Increase when retrying after `BUDGET_RESPONSE_TOO_LARGE`. |

## Capabilities

- **`outline`**: Lists every symbol (`component`, `function`, `class`, `method`, `composable`, `store`, `type`, `interface`, `enum`, `variable`, `slot`) with line bounds, `symbolId`, and a hash-verified `sourceRef`.
- **`contract`**:
  - Expands external cross-package types, generics, `Omit<>`, `Pick<>`, and intersections via the TypeScript `TypeChecker` (such as Vue `defineProps<Omit<OrderDTO, 'internalNote'> & { compact?: boolean }>()`, type-based `defineEmits`, React `interface Props extends BaseProps`, and Svelte `$props<T>()`).
  - Reports `props`, `emits`, `models` (`defineModel` / `v-model`), declared `slots`, rendered child components, and `renderBoundary` (`client`, `server`, `island`, `universal`).
- **`boundaries`**:
  - Traces inline HTTP calls (`fetch`, `$fetch`, `useFetch`, `useAsyncData`, Axios, `useSWR`, `useQuery`) and **graph-first 1-hop calls** through imported or Nuxt auto-imported composables directly via SQLite `symbol_edges` (`calls` / `reads_state` → `outbound_http`), reading the callee file from disk only when `payload.method` is not already stored in the edge payload.
  - When `resolve_types: true`, falls back to AST inspection + `SemanticProjectPool.getDefinitionsAtOffset` only for called identifiers not already covered by SQLite graph edges.
  - Matches outbound HTTP URLs against indexed fullstack API routes (`server/api/**`, `app/api/**`) to populate `backendTargetHint`, and emits a `DYNAMIC_HTTP_METHOD` diagnostic when the HTTP method is determined at runtime.
- **`imports`**: Lists static and dynamic module imports with their resolved internal workspace file path (`resolvedPath`) or external package specifier.
- **`omissions`**: Flags dynamic spreads (`v-bind="attrs"`, `{...props}`) with exact `sourceRef` handles for manual review.
