# MCP Resources and Prompts

`src/resources-and-prompts.ts`, `src/workflow-playbooks.ts`, and `src/mcp.ts` expose read-only MCP resources, a parameterized component resource template, and workflow prompts alongside the 6 public tools.

## Resources (`resources/list`, `resources/templates/list`, `resources/read`)

Resource reads do not initialize or sync an index. They can read an available
workspace or ancestor index through a read-only connection and use filesystem
discovery where the implementation supports fallback. Results depend on current
source and available index data. Reading a resource does not establish index freshness.

The MCP handlers resolve the workspace from the last known project root or the
server's working directory. They do not receive a tool `session_id` or explicit
`root` through these request handlers. Resources and prompts run outside the
`tools/call` supervisor queue.

| URI / Template | MIME Type | Purpose | Budget & Bounds |
|---|---|---|---|
| `strata://project/overview` | `application/json` | Detected frameworks, router, state managers, `.strata/graph.db` index status, and file/component/route/state counts. | Single summary object |
| `strata://components/index` | `application/json` | Bounded list of discovered components and workspace-relative paths without source bodies. | Capped at 150 items and trimmed to at most 16 KiB (16,384 UTF-8 bytes of resource text) (`DEFAULT_RESPONSE_BUDGET_BYTES`) |
| `strata://component/{name}` | `application/json` | Component contract summary (`props`, `emits`, `slots`, `models`, `stateDependencies`, `dataDependencies`) for matching component names. | Capped at 5 matches and trimmed to at most 16 KiB (16,384 UTF-8 bytes of resource text) |

## Prompts (`prompts/list`, `prompts/get`)

`WORKFLOW_PLAYBOOKS` in `src/workflow-playbooks.ts` is the single source of truth shared between MCP Prompts (`prompts/get`) and the `SKILL.md` template (`USE_STRATA_SKILL_TEMPLATE` in `src/cli/templates.ts`).

`prompts/get` returns an embedded project overview and text describing the
workflow. The client or agent decides whether to execute the suggested tool calls.

| Prompt | Arguments | Embedded Resource | Tool Sequence |
|---|---|---|---|
| `trace-state-bug` | `target` (required) | `strata://project/overview` | `find_code` → `inspect_component` → `trace_state` |
| `safe-component-patch` | `component` (required), `refactor_type` (optional) | `strata://project/overview` | `inspect_component(impact: "summary")` → `get_component_tree(direction: "upward")` → `generate_patch_plan` |
| `audit-component-tree` | `entry` (required) | `strata://project/overview` | `get_component_tree(direction: "downward")` → `inspect_component` → `audit_frontend` |

## Server instructions

`STRATA_INSTRUCTIONS` in `src/instructions.ts` provides a concise routing compass, resource/prompt pointers, and hard evidence boundaries on `initialize`. Detailed parameter schemas remain in `tools/list` (`src/tools/catalog.ts`), and multi-step playbooks live in MCP Prompts and generated `SKILL.md` files.

## Verification

- `tests/mcp/resources-and-prompts.test.ts`: validates resource/prompt metadata, 16 KiB smart truncation, read-only behavior without creating `.strata/`, and anti-drift checks verifying that `WORKFLOW_PLAYBOOKS` and `USE_STRATA_SKILL_TEMPLATE` only reference active tool names and schema parameters.
- `tests/integration/mcp-server-protocol.test.ts`: verifies `initialize` capabilities (`tools`, `resources`, `prompts`), `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, and `prompts/get` over stdio JSON-RPC.
