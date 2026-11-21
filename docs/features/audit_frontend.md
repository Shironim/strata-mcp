# audit_frontend — routes, calls and unused-code candidates

Run one of four static audits or aggregate all four. Output is evidence within
the collected scope and supported syntax, not a complete runtime architecture
inventory or permission to delete reported code.

## Preconditions and parameters

| Target | Index requirement | Primary fields |
|---|---|---|
| `routes` | None; reads source/configuration | `framework`, `baseDirectory`, `totalRoutes`, `routes`, optional view/ownership metadata |
| `api-contracts` | None; reads source | `workspaceRoot`, `totalEndpointsFound`, `endpoints` |
| `dead-components` | None; reads source | `targetPath`, `totalScanned`, `unusedCount`, `unusedComponents`, `orphanComponents`, `unreferencedPages` |
| `dead-state` | Initialized workspace or indexed ancestor; refreshes first | `workspaceRoot`, `totalScanned`, `unusedCount`, `unusedState` |
| `all` (default) | Same as `dead-state` | `routes`, `unusedComponents`, `unusedState`, `apiContracts`, each containing its own result |

On an uninitialized workspace, `dead-state`/`all` fail with a `NOT_INDEXED` error.
The filesystem targets remain available. Use `strata init` for indexed targets;
`find_code(action: "map")` does not initialize an index. Aggregation waits for
started sibling analyses to settle before returning a failure.

| Parameter | Effective behavior |
|---|---|
| `path` | Project directory; aliases `target_path`, `targetPath`. Falls back to the resolved current root. |
| `target` | `routes`, `api-contracts`, `dead-components`, `dead-state`, `all` (default). Unsupported values are errors. |
| `scope_path` | Scope within the root; aliases `scopePath`, `scope_filter`, `scopeFilter`. Semantics vary by target; scoped findings do not guarantee only scoped I/O/sync. |
| `exclude_dirs` | Collector exclusions; alias `excludeDirs`. |
| `ignore_patterns` | Unused-component glob exclusions; alias `ignorePatterns`. A nonempty custom list replaces that audit's default ignore list. |
| `include_pages` | Include page/view candidates in unused-component findings; default false, alias `includePages`. |
| `framework` | Route hint: `next-app`, `next-pages`, `nuxt`, `astro`, `sveltekit`, `inertia`, `vue-router`, `unknown`; aliases `framework_hint`, `frameworkHint`. |
| `view` | Route display: `summary`, `full`, `tree`; also forwarded to routes in `all`. A targeted route request defaults to summary. |
| `prefix` | URL-prefix filter for routes. |

`format` (`text`/`json`), `include_structured`, `response_detail`, `max_bytes`
and `continuation_token` follow the [shared contract](retrieval-evidence-contract.md).
Route `view: "summary"` and response `response_detail: "summary"` are different
layers: one selects the route view, the other projects the tool response.

## Routes and outbound calls

Routes use supported conventions/configuration for Next.js, Nuxt (including
supported `app/` layouts), SvelteKit, Astro, Inertia and Vue Router. Results can
include parameters, handlers, layouts, ownership/configuration evidence and
framework-specific metadata. Dynamic registrations and unresolved expressions
remain limits; a framework hint is not runtime proof.

API extraction scans collected modules independently for supported fetch/axios,
router, SWR and query-key patterns. Each detected item uses `file`, `line`,
`column`, `endpoint`, `method`, `clientKind`, optional `payloadParams`, and a
synthesized `backendTargetHint`. A query key can supply a candidate endpoint;
this is not proof that a request executes. This scanner does not perform
`inspect_component`'s one-hop imported-composable enrichment at the consumer;
calls in a collected hook module are reported at that module's source location.
Its output differs from the inspector's `boundaryContracts` shape.
Dynamic/unsupported calls need independent inspection.

`backendTargetHint` is an optional object with `targetIntent`, `routePattern`,
`suggestedSymbols`, optional `namedRoute`, `isHeuristic`, `disclaimer`. It
derives candidate names from endpoint/route conventions, without establishing
that a controller exists or validating backend routes. Strata does not invoke
Septum. Another tool can consume these candidates after independently checking
the backend repository.

## Unused-code audits

`dead-components` scans UI files (`.vue`, `.astro`, `.svelte`, `.tsx`, `.jsx`).
Default exclusions cover page/view/route/app conventions, layouts and test/story
files, with component-directory exceptions such as Nuxt `app/components/`.
`include_pages` and custom ignore patterns change those selections.

Rendered React bindings resolve to source files, including named exports that
differ from filenames, local aliases, namespace members and supported named barrel
re-exports. Import-only bindings do not count as rendered usage; lexical shadowing
is checked for JSX imported bindings. A module with any rendered export is used;
this is not per-export dead-code analysis. Dynamic/global registration scans and
filename/tag matching remain heuristics. Unsupported indirect loading and
re-export patterns can require manual investigation.

`dead-state` selects declaration candidates through directory/basename conventions
and supported exported-identifier patterns, then checks indexed external consumers
by identifier. It does not resolve every state declaration or runtime object.
Scope limits findings while outside consumers can still be considered.
Exclusions and parser coverage affect these observations.

Neither audit proves safe deletion. Read failures, unsupported syntax, duplicate
names, indirect registrations and runtime loading warrant source inspection.

## Requests and response review

```json
{"target":"routes","path":".","view":"full","prefix":"/dashboard","format":"json","response_detail":"full"}
```

```json
{"target":"dead-components","path":".","scope_path":"src/components","format":"json","response_detail":"full"}
```

```json
{"target":"api-contracts","path":".","format":"json","response_detail":"full"}
```

Results include target-specific data and retrieval/decision metadata. `all`
contains independent collections: a small budget can require a narrower target
or larger budget instead of one universal continuation stream. Counts and a
formatter's zero-finding message do not override evidence limitations.

CLI `strata audit`/`unused` currently defaults to `dead-components`, whereas
the MCP tool defaults to `all`. CLI JSON prints the selected analysis data,
not the MCP response envelope. Supply a target explicitly when moving between
entry points.

## Owners and verification

- [Handler](../../src/tools/audit-frontend.ts), [shared execution](../../src/engine/frontend-audit.ts).
- [Routes](../../src/engine/routes.ts), [API contracts](../../src/engine/api-contract.ts),
  [unused components](../../src/engine/audit.ts), [unused state](../../src/engine/storage/unused-state.ts).
- [Audit tests](../../tests/core/audit.test.ts),
  [named-export regressions](../../tests/core/real-world-analysis-regression.test.ts),
  [scope/freshness tests](../../tests/core/after-bugfix-review.test.ts),
  [MCP regressions](../../tests/mcp/improvements-regression.test.ts).
