# MCP Resources & Workflow Prompts

Strata MCP exposes read-only MCP Resources for fast orientation and 3 guided Workflow Prompts aligned with its 5 MCP tools.

## Resources

- **`strata://project/overview`**: Workspace framework detection, router, state managers, and `.strata/graph.db` index status.
- **`strata://components/index`**: Bounded list of discovered components and relative paths without source bodies.
- **`strata://component/{name}`**: Read-only component contract summary.

## Prompts (Workflow Playbooks)

1. **`onboard-workspace`** (`package?`): Orient in a new repository or monorepo package using `map_workspace(view: "overview" | "routes")` → `inspect_file` on key entrypoints.
2. **`trace-bug`** (`target`): Locate symbol via `search_code` → trace `query_graph(query: "state_flow" | "call_hierarchy")` → read exact lines via `read_slice`.
3. **`safe-refactor`** (`component`, `member?`): Inspect contract via `inspect_file` → map upward consumers via `query_graph(query: "component_tree", direction: "up")` → compute verified edit sites & omissions via `query_graph(query: "impact")`.
