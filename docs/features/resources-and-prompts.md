# MCP Resources, Explorer App & Workflow Prompts

Strata MCP exposes an interactive MCP App (`ui://strata/explorer.html`), read-only MCP Resources for fast orientation, and 4 guided Workflow Prompts aligned with its 5 MCP tools (`src/resources-and-prompts.ts`, `src/workflow-playbooks.ts`).

## Resources

All data resources accept an optional `?workspace=<path>` query parameter to target a specific workspace root:

- **`ui://strata/explorer.html`** (`text/html;profile=mcp-app`): Interactive **Strata Explorer** MCP App for browsing workspace overview, page/API routes, component trees, TypeChecker contracts, impact sites, and unused component triage.
- **`strata://project/overview`** (`application/json`): Detected monorepo packages, frameworks, routers, and file/symbol/route totals for the active workspace.
- **`strata://components/index`** (`application/json`): Bounded list of discovered frontend components and their package-relative paths without source bodies.
- **`strata://apps`** (`application/json`): Strata Explorer MCP App entrypoints, workspace verification/health summary, and recommended next actions.
- **`strata://component/{name}`** (`application/json` resource template): Read-only component outline, TypeChecker-resolved props/emits/models/slots contract, and outbound HTTP boundaries.

## Prompts (Workflow Playbooks)

1. **`open-apps`** (`workspace_path?`): Launch the interactive **Strata Explorer** UI via `map_workspace(view: "overview")` and `map_workspace(view: "health")` (or `strata://apps`), then summarize package totals, routes, and component health.
2. **`onboard-workspace`** (`package?`): Orient in a new repository or monorepo package using `map_workspace(view: "overview" | "routes")` → `inspect_file` on key entrypoints.
3. **`trace-bug`** (`target`): Locate a symbol via `search_code(kind: "symbol")` → trace `query_graph(query: "state_flow" | "call_hierarchy")` → read exact lines via `read_slice`.
4. **`safe-refactor`** (`component`, `member?`): Inspect the contract via `inspect_file` → map upward consumers via `query_graph(query: "component_tree", direction: "up")` → compute verified edit sites and `DYNAMIC_SPREAD` omissions via `query_graph(query: "impact")`.
