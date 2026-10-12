export const STRATA_INSTRUCTIONS = `# Strata MCP Server — Best Practices & Usage Instructions

Strata MCP is a high-performance structural AST search, component inspection, and dependency graph engine for frontend and fullstack codebases (Vue SFC, Astro, React/TSX, and TypeScript).

## Core Principles & Token Economy (Zero Raw Byte Dumping)
- **Never Dump Whole Files**: Do NOT use whole-file view tools (> 50 lines) merely to understand component props, emits, methods, or structure. Use \`inspect_component\`.
- **AST Over Regex/Grep**: Do NOT perform iterative grep loops. Use \`find_code\` for structural AST matching or \`get_component_tree\` for component dependency resolution.
- **Output Format Protocol**: Default to \`output_format: "text"\` for concise, human/LLM-readable summaries. Use \`output_format: "json"\` when programmatic tree traversal or large batch aggregation is required.
- **No Micro-Verification Looping**: Complete all planned code modifications in a batch before running post-flight checks. Never verify between micro-edits.

## The Dual-Phase Workflow (Pre-Flight & Post-Flight Quality Gate)

Always operate in two distinct phases:

1. **Phase 1: Pre-Flight Discovery (Before Editing)**
   - Extract public props, emits, slots, and models via \`inspect_component(path: "...")\` without opening raw files.
   - Slice target functions with exact line coordinates & callers via \`inspect_component(symbol: "...")\`.
   - Calculate blast radius via \`get_component_tree(direction: "upward")\` before modifying shared components.

2. **Phase 2: Post-Flight Verification Gate (Batch-First, Once After All Edits Complete)**
   - **Batch-First Editing**: Complete the ENTIRE planned sequence of code modifications on the target file/batch first.
   - **No Micro-Verification Looping**: Do NOT run verification between small, incremental edits.
   - Run \`inspect_component(path: "...", audit_events: true)\` after edits for targeted diagnostics:
     - **Broken Handlers**: Template events (e.g., \`@click="handleSubmit"\`) pointing to undeclared script functions.
     - **Dead Handlers**: Obsolete methods left behind after refactoring.
     - **Reactivity Smells**: Vue 3 props destructuring without \`toRefs\`, direct prop mutations, or React inline allocation traps.
   - *Verification scope*: These diagnostics supplement compiler, lint, and behavioral tests; they do not prove runtime correctness. Latency and output size depend on the component.

## Core Tool Quick Selector

| Investigation Need | Recommended Tool | Key Arguments | Delivered Value |
|---|---|---|---|
| **Component Interface Contract** | \`inspect_component\` | \`path: "..."\` | Public props, emits, slots, models, variants, layout token classes, and bidirectional data transport hazard analysis without HTML bloat. |
| **Precision Function Slicing** | \`inspect_component\` | \`path: "...", symbol: "..."\` | Isolated method/symbol body with exact line numbers & callers. |
| **Audit Events & Reactivity** | \`inspect_component\` | \`path: "...", audit_events: true\` | Detect broken template-to-script handlers & Vue/React reactivity smells. |
| **Downward Component Hierarchy** | \`get_component_tree\` | \`path\` (or \`entry_path\` / \`route\`), \`direction: "downward"\` | Complete rendered child tree & props drilling detection. |
| **Upward Blast Radius** | \`get_component_tree\` | \`path: "...", direction: "upward"\` | All parent components and pages impacted by modifying a leaf file. |
| **Route Map & Topology** | \`get_routes\` | \`path?: "...", framework?: "next-app"|"nuxt"|"astro"|"inertia"\` | Instant file-based routing topology, layouts, dynamic parameters, and page handlers. |
| **Outbound API Contracts** | \`get_api_contracts\` | \`path?: "...", scope_path?: "..."\` | Maps API endpoints, HTTP methods, network boundaries, and \`backendTargetHint\` (inferred backend symbol candidates, not verified route-to-controller links). |
| **Trace State & Composables** | \`trace_state\` | \`identifier: "...", depth: 1|2+, direction?: "consumers"|"dependencies"|"both"\` | Map consuming components for Pinia/Zustand stores, contexts, composables. |
| **Health, Duplication & APIs** | \`audit_frontend\` | \`target?: "all"|"routes"|"dead-components"|"dead-state"|"similar-templates"|"design-tokens"|"bundle-health"|"api-contracts"|"archetype-drift"\` | Diagnostic manifest of dead components/state, duplicated templates, design token drift, hydration weight, archetype drift, and routes/APIs. |
| **Prescriptive Patch Plan** | \`generate_patch_plan\` | \`path: "...", refactor_type: "rename_prop"|"remove_prop"|"rename_event"|"rename_model"|"rename_slot", old_name: "...", new_name?: "..."\` | Prescriptive AST patch recommendations (file, line, column, replacement snippet) across all consumers. |
| **Structural AST Search** | \`find_code\` | \`pattern: "..."\` or \`component: "..."\` | ast-grep pattern matches or component usage occurrences across repo. |

## Maximizing the Persistent Knowledge Graph (\`.strata/graph.db\`) & Realtime Watcher

Strata maintains a high-speed SQLite dependency graph at \`.strata/graph.db\` with native background realtime watching:

1. **Background Delta Sync**: The filesystem watcher (\`node:fs.watch\`) debounces source changes (100ms by default) and runs the same delta sync as the CLI. Each sync scans file metadata and parses changed files; debounce time is not a latency guarantee.
2. **Upward Blast Radius Traversal**: \`get_component_tree(direction: "upward")\` reads workspace source and resolves consumers in memory. SQL blast-radius helpers exist for database queries but are not the MCP tree execution path.
3. **Prescriptive Code Migrations**: Combine blast radius discovery with \`generate_patch_plan\` to obtain AST patch recommendations within the traversed consumers. Review patches and run tests before applying a refactor.
4. **Multi-Hop State Impact**: When altering a store or composable, use \`trace_state\` with \`depth: 2+\` to follow chained composable consumption across the graph.
5. **Direct SQLite Analytics (Advanced)**: The SQLite database at \`.strata/graph.db\` contains 5 indexed tables (\`files\`, \`components\`, \`edges\`, \`state_deps\`, \`routes\`). You can directly run SQL queries against it to extract custom architectural metrics (e.g., detecting "God Components" with high fan-out, critical foundation components with high fan-in, or finding orphan files).
`.trim();
