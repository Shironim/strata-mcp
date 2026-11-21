# trace_state — shared dependency impact and chains

Query indexed store, context and composable dependencies. Direct impact groups
files as readers or mutators; chain mode follows bounded consumer/dependency
relationships. Classification is static and framework-specific, not an execution
trace or a general local-variable dataflow analyzer.

## Preconditions and parameters

The MCP handler requires an initialized workspace or indexed ancestor. It returns
`NOT_INDEXED` when none exists and refreshes the index before querying.
Initialize with `strata init`; `find_code(action: "map")` does not create an index.
Refresh failures are errors, not successful empty dependency lists.

| Parameter | Effective behavior |
|---|---|
| `identifier` | Dependency key. Aliases include `state`, `state_name`, `store`, `store_name`, `composable`, `name`, `symbol` and supported camelCase forms. |
| `path` | Project directory or file; aliases `target_path`, `file_path`, `filePath`. Default is the resolved current root. |
| `root` | Optional explicit workspace hint; normalized aliases include `workspace_root`, `project_root`. |
| `depth` | Default 1; aliases `max_depth`, `maxDepth`. Chain traversal bound. |
| `direction` | `consumers`, `dependencies`, `both`. Effective default depends on depth; see routing below. |
| `role` | `all` (default), `mutators`, `readers`. A file with any indexed write is a mutator even when it also reads. |

Formats are `text` or `json`; `include_structured`, `response_detail`,
`max_bytes` and `continuation_token` follow the [shared contract](retrieval-evidence-contract.md).

With a file path and no identifier, the handler attempts detection from supported
`defineStore` or exported `use*` patterns. One candidate selects that identifier;
several require an explicit selection. If no candidate is found, the file path can
query all indexed dependencies of that file. Thus `identifier` is conditional.
A file supplied alongside an identifier helps resolve the workspace; it does not
restrict impact to that file.

## Routing and result shapes

| Request | Operation | Primary result fields |
|---|---|---|
| Depth 1, direction omitted or `consumers` | Direct impact | `identifier`, `totalConsumers`, `roleFilter`, `mutatorsCount`, `readersCount`, `mutators`, `readers`, `consumers`, `_meta` |
| Depth greater than 1 | Chain; direction defaults to `both` | `identifier`, `entryFile`, `consumers`, `dependencies`, `_meta` |
| Explicit `dependencies` or `both`, including depth 1 | Chain | Same chain fields; not a direct-impact payload. |
| File lookup without a resolved identifier | File dependencies | `filePath`, `workspaceRoot`, `roleFilter`, `totalDependencies`, `dependencies`, `_meta` |

The schema describes `both` as the chain default. Omitting direction at the
default depth actually selects direct consumers. Specify direction and depth
when the result shape matters.

Direct impact aggregates rows by file and filters `consumers` by role. Counts
describe the observed consumer set, not necessarily the returned page.
`mutators`/`readers` are grouped files, not runtime execution sites.
Chain consumers start from role-matching direct consumers and follow upstream
import relationships; deeper nodes do not prove direct state access.
Declaring-file discovery, requested scope, package boundaries, depth and graph
coverage constrain the result. `both` does not establish an entire runtime lineage.

## Framework-specific classification

Vue extracts executable script/template expressions before classification.
Access modes combine these expressions with assignment and naming heuristics:

- Property reads are readers. Getter-style calls such as `getTotal()` are treated
  as reads; unknown instance methods are conservative writes. Names are not proof
  of a method's effects.
- Supported property/compound assignments (`+=`, `||=`, nested dotted assignments),
  calls such as `store.toggle()`, `v-model="store.open"` and bare event handlers
  such as `@click="store.toggle"` are writes.
- Ordinary `:handler="store.toggle"` binding is a read. Supported destructured
  aliases retain source coordinates; supported watch patterns use `watch`.
- Vue `v-for` aliases shadow script bindings within the loop. The iterable
  is analyzed in its enclosing scope.
- Nuxt tracks local refs initialized by `useState` with a literal key. Direct
  script writes such as `count.value = 0` and template writes such as `count++`
  can be attributed to the key.
- Store/composable member accesses (`store.items`, `store.checkout()`) and
  destructured bindings populate `accessedProperties`, excluding Pinia meta
  members (`$patch`, `$reset`, `$subscribe`, `$onAction`, `$state`, `$id`, `$dispose`).
  An absent property list means no tracked member access was statically matched on that line.

React uses lexical import bindings and AST access classification for supported
stores, contexts and custom hooks. Type-only imports and shadowed bindings are
distinguished. Supported React dependencies can include `accessedProperties`.
Calling an alias returned by a direct store selector such as `state => state.clear`
can be reported as a write using action-name heuristics.
React built-ins such as local `useState`/`useReducer` are not themselves shared
dependency keys; invoking a local setter does not create a shared-state record.

Other frameworks, auto-imports and composables use supported syntax and naming
conventions. Support for one store pattern does not establish all APIs, wrappers,
aliases or runtime effects. `actionsCalled` may contain normalized snippets such
as `ui.toggle()`, not bare method names or original arguments.
`lineNumber` and `usageSnippet` come from the same observation. Direct queries
prefer writes, then watches, then reads. Within a mode, the earliest located
observation is preferred. A reader's selected line can be its import or initialization.

## Requests and errors

```json
{"identifier":"useUiStore","path":".","depth":1,"direction":"consumers","role":"mutators","format":"json","response_detail":"full"}
```

```json
{"identifier":"useUiStore","path":".","depth":2,"direction":"both","format":"json","response_detail":"full"}
```

Missing/ambiguous identifiers, uninitialized workspaces and failed refresh/read
operations require resolving the reported cause. Empty results are limited by
identifier matching, index/parser coverage and traversal scope. Summary projection
and pagination further limit returned data; inspect retrieval/decision and
continuation metadata before concluding absence.

CLI `strata trace` requires a positional identifier and uses direct impact/chain
engine functions. Its JSON is the analysis data without the MCP envelope; the
MCP file-based identifier detection/fallback is not a CLI input contract.

## Owners and verification

- [Handler/routing](../../src/tools/trace-state.ts), [direct impact](../../src/engine/storage/state-impact.ts),
  [chains](../../src/engine/storage/state-chain.ts), [formatting](../../src/engine/storage/state-format.ts).
- [Vue/general parser](../../src/engine/parsers/state-dependency.ts),
  [React parser](../../src/engine/parsers/react-state-dependency.ts).
- [Template/role regressions](../../tests/core/real-world-analysis-regression.test.ts),
  [role/invalidation tests](../../tests/core/after-bugfix-review.test.ts),
  [MCP root boundaries](../../tests/mcp/root-boundaries.test.ts).
