# Strata feature contracts

**Baseline:** local source, package `0.8.2`; reviewed 2026-11-14.

These documents describe implemented behavior and its static-analysis limits.
The catalog, request normalization, handlers and engine code own the actual
contract. A document date or package version does not establish that an installed
MCP server has loaded that source revision.

## Choose an operation

| Need | Tool | MCP index requirement |
|---|---|---|
| Inventory files or search patterns/component usages | [find_code](find_code.md) | None |
| Inspect a contract, map a file, retrieve source or slice a symbol | [inspect_component](inspect_component.md) | None |
| Traverse rendered children or upstream consumer candidates | [get_component_tree](get_component_tree.md) | Initialized workspace or indexed ancestor |
| Query shared state consumers or dependency chains | [trace_state](trace_state.md) | Initialized workspace or indexed ancestor |
| Inspect routes, outbound calls or unused-component candidates | [audit_frontend](audit_frontend.md): `routes`, `api-contracts`, `dead-components` | None |
| Inspect unused-state candidates or run all audits | [audit_frontend](audit_frontend.md): `dead-state`, `all` | Initialized workspace or indexed ancestor |
| Propose edits to static consumer usages | [generate_patch_plan](generate_patch_plan.md) | Optional; source fallback is supported |

`find_code(action: "map")` inventories files; it does not initialize an index.
Use `strata init` to initialize one. Indexed analyses refresh before querying;
this includes scanning, hashing and possible reparsing. Library and CLI behavior can differ from
MCP admission checks; each feature documents the relevant boundary.

## Shared contracts

- [Retrieval evidence and responses](retrieval-evidence-contract.md): `format`,
  `response_detail`, `include_structured`, `max_bytes`, continuation, decision
  metadata and the schema/runtime default discrepancy.
- [Storage and delta sync](storage-and-delta-sync.md): index discovery, schema,
  publication, invalidation and revision identity.
- [Lifecycle hooks](lifecycle-hooks.md): generated hooks, execution queue,
  cancellation and client integration limits.
- [Tool-call logging](tool-call-logging.md): local telemetry, masking, rotation
  and failure isolation.

Application source is analyzed statically. Internal indices and telemetry can be
updated, and AST searches launch a local ast-grep subprocess. Results do not prove
runtime execution, complete consumer coverage or safe deletion/refactoring.
Inspect `retrieval`, `decision`, diagnostics and omissions before drawing an
absence conclusion. Backend hints are candidate names for independent backend
inspection; Strata does not invoke a backend tool automatically.

## Maintaining these documents

1. Check [catalog](../../src/tools/catalog.ts),
   [normalization](../../src/tools/request.ts), the handler and its engine path.
   Record schema/runtime conflicts rather than treating JSON Schema defaults
   or descriptions as executable behavior.
2. Document support per operation and framework. Distinguish exact source
   coordinates from heuristic identity, graph coverage and runtime effects.
3. Use reproducible fixture requests for examples. Label output excerpts;
   do not invent fields or completeness claims, or promise token savings,
   token consumption, response speed or efficiency improvements.
4. Link owning source and regression tests. Tests establish their executed cases,
   not universal framework support or installed-server parity.
