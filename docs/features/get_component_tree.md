# get_component_tree — bounded component relationships

Traverse downstream rendered component candidates or upstream consumers from a
file or resolved route. Downward analysis also reports supported prop forwarding
and context relationships. A tree is a bounded static observation, not a complete
inventory of components rendered at runtime.

## Preconditions and entry points

Both the **MCP handler** and the library `getComponentTree` support **source fallback**
on uninitialized workspaces without creating `.strata`. When an initialized index exists,
it is refreshed before traversal (`retrieval.index` is populated; otherwise `retrieval.index`
is `null` and `retrieval.basis` is `derived`). Failed index refresh is an analysis error.

CLI `strata tree` calls the library path and prints analysis data directly;
it does not use the MCP response envelope.

## Parameters

| Parameter | Effective behavior |
|---|---|
| `path` | Entry component/module when file-like; otherwise can supply the scan root. File aliases include `entry_path`, `entryPath`, `file_path`, `filePath`, `component`, `component_path`. |
| `route` | Resolve a URL route to an entrypoint; alias `route_path`. Supply a file or route. |
| `target_path` | Scan/project root, distinct from the entry file; aliases include `root`, `workspace_root`. Otherwise inferred from the entry or current root. |
| `direction` | `downward`/`down` (default) or `upward`/`up`. |
| `max_depth` | Traversal bound, default 3; aliases include `depth`, `maxDepth`. |
| `limit` | Upward consumer cap, default 20; accepted aliases include `max_results`, `maxResults`. |
| `scope_filter` | String scope filter, aliases `scope_path`, `scopeFilter`, `scopePath`. Traversal can stop at a scope boundary; this is not OS isolation. |
| `alias_map` | Explicit import aliases overriding detected mappings; aliases `aliasMap`, `alias`. |
| `include_props` | Default true. False strips returned `passedProps` from nodes; alias `includeProps`. It does not disable underlying analysis. |

Formats are `text`, `json`, `mermaid`. Response detail, `include_structured`,
`max_bytes` and `continuation_token` follow the [shared contract](retrieval-evidence-contract.md).
Traversal diagnostics and response-budget truncation are separate limits.

## Execution and limits

- **Route resolution:** Uses supported Next.js, Nuxt, SvelteKit, Astro, Inertia, and Vue Router scanners based on ownership/configuration evidence. Not every runtime registration or expression can be resolved; inspect the route manifest/diagnostics when selection fails.
- **Downward traversal:** Reads source and resolves supported rendered tags, imports, aliases, and static auto-import candidates. Literal JSX tags are attributed using their lexical binding. Ambiguous auto-imports, unresolved imports, failed reads, malformed Vue input, and traversal boundaries have diagnostics.
- **Upward traversal:** Prefers reverse edges from an index for the requested workspace, including import-only, rendered, and resolved auto-import relationships. Requests with an explicit alias map use source resolution. Circular branches terminate cleanly. Depth 3 and the default 20-consumer cap bound traversal.
- **Next App Router page role:** The route scanner, source traversal, and SQLite use the same supported page filenames under the application's selected `app` or `src/app` directory.
- **Prop-drilling detection:** Follows supported prop-name/identifier forwarding chains with a computed depth threshold of at least 2. This forwarding heuristic does not prove that intermediate components never use the prop locally.
- **Context extraction & bounds:** Recognizes Vue `provide`/`inject`, Svelte `setContext`/`getContext`, and React provider/`useContext` patterns (including local/re-exported React hook wrappers such as `useTheme()`, attributed as `react-hook-wrapper` with candidate evidence). Context keys are source syntax rather than verified runtime object identity or JSX provider lifetime. Traversal stops at cycles, 12 resolution steps, 256 modules, or 4096 resolution operations; external package hooks and dynamic factories remain outside coverage.

## Results and requests

Full results include `root`, `totalComponents`, `maxDepthReached`, `direction`,
diagnostics and, where produced, `propsDrilling`, `contextGraph`, `resolvedRoute`.
Nodes carry file/component identity, depth, children and optional props, boundary,
dynamic/circular and relation evidence. `contextGraph` contains providers,
consumers, relations and dangling consumers. Summary responses contain previews
rather than the full tree; review retrieval/decision metadata alongside them.

Example requests; replace the paths or route with the intended project:

```json
{"path":"src/App.vue","target_path":".","direction":"downward","max_depth":3,"format":"json","response_detail":"full"}
```

```json
{"path":"src/components/Card.vue","target_path":".","direction":"upward","limit":50,"format":"json","response_detail":"full"}
```

```json
{"route":"/dashboard","target_path":".","direction":"downward","format":"mermaid","response_detail":"full"}
```

## Owners and verification

- [MCP handler](../../src/tools/component-tree.ts), [library facade](../../src/engine/tree.ts).
- [Downward](../../src/engine/graph/downward-traversal.ts), [upward](../../src/engine/graph/upward-traversal.ts),
  [context extraction](../../src/engine/graph/context-analyzer.ts), [hook context](../../src/engine/graph/hook-context.ts).
- [Unresolved-tree tests](../../tests/core/tree-unresolved.test.ts),
  [upward evidence](../../tests/core/tree-upward-evidence.test.ts),
  [hook regressions](../../tests/core/real-world-analysis-regression.test.ts),
  [MCP root boundaries](../../tests/mcp/root-boundaries.test.ts).
