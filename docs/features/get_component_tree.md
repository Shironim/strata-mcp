# get_component_tree — bounded component relationships

**Status:** Implementation contract. **Reviewed:** 2026-11-14, package `0.8.2`.

Traverse downstream rendered component candidates or upstream consumers from a
file or resolved route. Downward analysis also reports supported prop forwarding
and context relationships. A tree is a bounded static observation, not a complete
inventory of components rendered at runtime.

## Preconditions and entry points

The **MCP handler requires an initialized index** in the workspace or an ancestor.
Otherwise it returns a `NOT_INDEXED` status. Run `strata init`; inventory through
`find_code(action: "map")` does not create that index. Initialized operations
refresh before traversal; failed refresh is an analysis error.

The library `getComponentTree` differs: downward traversal can read source without
an index, and upward traversal retains source fallback on uninitialized workspaces.
Library fallback does not implicitly initialize `.strata`. A successful library
call therefore does not mean that MCP accepts an unindexed request.

CLI `strata tree` calls the library path and prints analysis data directly;
it does not have the MCP handler's index-admission or response-envelope contract.

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

Route resolution uses supported Next.js, Nuxt, SvelteKit, Astro, Inertia and Vue
Router scanners. Ownership/configuration evidence determines the scanner and
metadata. Not every runtime registration or expression can be resolved; inspect
the route manifest/diagnostics when selection fails.

Downward traversal reads source, extracts supported rendered tags and resolves
imports, aliases and framework auto-import candidates. Static dictionary/dynamic
expressions can contribute candidates; unsupported selectors produce diagnostics
or warning nodes. This does not enumerate all runtime selector values.
Unresolved imports, failed reads, malformed Vue input, scope and depth boundaries
are not equivalent to a component with no children.

Upward traversal prefers indexed reverse edges, with source fallback at the
library boundary. It can retain import-only and rendered relationships; inspect
relation evidence. Circular branches stop instead of expanding forever.
Depth 3 and the default 20-consumer cap prevent an unqualified workspace-wide
blast-radius claim. Execution includes index preflight and filesystem reads in
addition to graph queries.

Prop-drilling detection follows supported prop-name/identifier forwarding chains.
Its computed depth threshold is at least 2. This is a forwarding heuristic; it
does not prove that intermediate components never use the prop locally.

Context extraction recognizes Vue provide/inject, Svelte setContext/getContext,
and React provider/useContext patterns. React wrappers such as `useTheme()` are
followed through supported local functions, relative/alias imports and named/default
re-exports. Derived consumers are attributed to the component's hook call line,
with method `react-hook-wrapper` and candidate evidence.

Context keys are source syntax, not verified runtime object identity or JSX
provider lifetime. A matching provider in the analyzed branch establishes only
`isCoveredInTree` within that static model. Hook module data is request-local
and reread on a later query. Traversal stops at cycles, 12 resolution steps,
256 modules or 4096 resolution operations. Unresolved/external package hooks and
dynamic factories remain outside coverage; an absent relation does not establish
no context dependency.

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
