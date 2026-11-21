# Strata feature contracts

These documents describe the implemented behavior, parameter normalization, response contracts, and static-analysis limits of Strata's MCP tools and supporting subsystems. The [catalog](../../src/tools/catalog.ts), [request normalization](../../src/tools/request.ts), handlers, and engine modules define the executable contract.

## Choose an operation

| Need | Tool | MCP index requirement |
|---|---|---|
| Inventory files or search patterns/component usages | [find_code](find_code.md) | None |
| Inspect a contract, map a file, retrieve source or slice a symbol | [inspect_component](inspect_component.md) | None |
| Traverse rendered children or upstream consumer candidates | [get_component_tree](get_component_tree.md) | Optional; source fallback is supported |
| Query shared state consumers or dependency chains | [trace_state](trace_state.md) | Initialized workspace or indexed ancestor |
| Inspect routes, outbound calls or unused-component candidates | [audit_frontend](audit_frontend.md): `routes`, `api-contracts`, `dead-components` | None |
| Inspect unused-state candidates or run all audits | [audit_frontend](audit_frontend.md): `dead-state`, `all` | Initialized workspace or indexed ancestor |
| Propose edits to static consumer usages | [generate_patch_plan](generate_patch_plan.md) | Optional; source fallback is supported |

`find_code(action: "map")` inventories files without creating an index; run `strata init` to initialize `.strata/graph.db`. Indexed analyses refresh before querying (scanning, hashing, and reparsing changed files). Library and CLI behavior can differ from MCP admission checks—each feature document notes the relevant boundary.

## Shared contracts

- [Resources and prompts](resources-and-prompts.md): read-only index access, component resource templates, and workflow playbooks.
- [Retrieval evidence and responses](retrieval-evidence-contract.md): `format`, `response_detail`, `include_structured`, `max_bytes`, continuation, and decision metadata.
- [Storage and delta sync](storage-and-delta-sync.md): index discovery, schema, publication, invalidation, and revision identity.
- [MCP lifecycle and hooks](lifecycle-hooks.md): stdio handshake, workspace selection, tool queue, cancellation, shutdown, and generated post-write hooks.
- [Tool-call logging](tool-call-logging.md): local telemetry, masking, rotation, and failure isolation.

## Static-analysis scope

- Application source is analyzed statically; AST searches launch a local `ast-grep` subprocess and internal indices/telemetry may be updated on disk.
- Results do not prove runtime execution, exhaustive consumer coverage, or safe deletion/refactoring—inspect `retrieval`, `decision`, `diagnostics`, and `omissions` before drawing an absence conclusion.
- Backend hints are candidate symbol names for independent backend inspection; Strata does not invoke backend tools automatically.
