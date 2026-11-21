export const STRATA_INSTRUCTIONS = `# Strata MCP — Frontend AST Intelligence & Selective Context Engine
Static AST analysis for Vue/Nuxt, React/Next, Svelte, and Astro. Read-only; never mutates source files.

## Routing & Selective Inspection (Map first, read selectively)
- **Resources & Prompts:** Read \`strata://project/overview\`, \`strata://components/index\`, or \`strata://component/{name}\` for fast orientation; use MCP Prompts (\`trace-state-bug\`, \`safe-component-patch\`, \`audit-component-tree\`) for guided multi-step workflows.
- **Survey & Search:** \`find_code(action: "map")\` for file inventory; \`find_code(pattern: "...")\` for AST/literal/prop searches.
- **Contracts & Slices:** \`inspect_component(path, view: "map")\` or \`outline: true\` before reading bodies; slice via \`symbol\`, \`source_range\`, or \`view: "source"\` with \`source_ref\`. Never invent line numbers.
- **Hierarchy & State:** \`get_component_tree\` for upward blast radius or downward props drilling; \`trace_state\` for store/context/composable readers and mutators.
- **Topology & Refactoring:** \`audit_frontend\` for \`routes\`, \`api-contracts\`, \`dead-components\`, or \`dead-state\`; \`generate_patch_plan\` for \`rename_prop\`/\`remove_prop\`/\`rename_event\`/\`rename_model\`/\`rename_slot\` plans.

## Hard Boundaries
- **Truncation & Budgets:** Follow \`source_range\` hints on slices >50 lines and \`continuation_token\` on paged lists. Default \`format: "text"\` omits redundant JSON.
- **Index Requirement:** \`trace_state\` and \`audit_frontend\` (\`dead-state\`, \`all\`) require \`.strata/graph.db\` (\`strata init\`); do not initialize unrelated workspaces.
- **Evidence Discipline:** Use absolute paths. Treat static diagnostics, \`backendTargetHint\`, and unused findings as candidates—verify scope, \`status\`, and \`omissions\`.
`.trim();
