# `inspect_file`

Inspect a frontend file's symbol outline, TypeChecker-resolved component contract, render boundary, outbound HTTP boundaries, and imports—**strictly without returning implementation bodies**.

## Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` *(required)* | — | Absolute or workspace-relative path (`.vue`, `.tsx`, `.jsx`, `.svelte`, `.astro`, `.ts`, `.js`). |
| `root` | `string` | session root | Workspace root directory. |
| `sections` | `Array<'outline' \| 'contract' \| 'boundaries' \| 'imports'>` | `['outline', 'contract', 'boundaries']` | Sections to include. |
| `resolve_types` | `boolean` | `true` | Enable the TypeScript `TypeChecker` for external prop type expansion and 1-hop composable HTTP tracing. |
| `format` | `'text' \| 'json'` | `'text'` | Output representation. |

## Capabilities

- **`outline`**: Every symbol (`component`, `function`, `class`, `method`, `composable`, `store`, `type`, `interface`, `enum`, `variable`, `slot`) with line bounds, `symbolId`, and hash-verified `sourceRef`.
- **`contract`**:
  - Expands external cross-package types, generics, `Omit<>`, `Pick<>`, and intersections via the TypeScript `TypeChecker` (e.g. Vue `defineProps<Omit<OrderDTO, 'internalNote'> & { compact?: boolean }>()`, React `interface Props extends BaseProps`, Svelte `$props<T>()`).
  - Reports declared `slots`, rendered child components, and `renderBoundary` (`client`, `server`, `island`, `universal`).
- **`boundaries`**: Traces inline HTTP calls (`fetch`, `$fetch`, `useFetch`) and **1-hop semantic calls** through imported or Nuxt auto-imported composables (via `.nuxt/imports.d.ts`).
- **`omissions`**: Explicitly flags dynamic spreads (`v-bind="attrs"`, `{...props}`) with exact `sourceRef` handles.
