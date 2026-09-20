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
   - Run \`inspect_component(path: "...", audit_events: true)\` exactly **ONCE** after all edits are finished to verify:
     - **Broken Handlers**: Template events (e.g., \`@click="handleSubmit"\`) pointing to undeclared script functions.
     - **Dead Handlers**: Obsolete methods left behind after refactoring.
     - **Reactivity Smells**: Vue 3 props destructuring without \`toRefs\`, direct prop mutations, or React inline allocation traps.
   - *Advantage*: Delivers instant semantic verification (< 50ms, < 20 lines) without noisy, token-heavy terminal builds or linter logs.

## Core Tool Quick Selector

| Investigation Need | Recommended Tool | Key Arguments | Delivered Value |
|---|---|---|---|
| **Component Interface Contract** | \`inspect_component\` | \`path: "..."\` | Public props, emits, slots, models, variants without HTML bloat. |
| **Precision Function Slicing** | \`inspect_component\` | \`path: "...", symbol: "..."\` | Isolated method/symbol body with exact line numbers & callers. |
| **Audit Events & Reactivity** | \`inspect_component\` | \`path: "...", audit_events: true\` | Detect broken template-to-script handlers & Vue/React reactivity smells. |
| **Downward Component Hierarchy** | \`get_component_tree\` | \`entry_path\` or \`route\`, \`direction: "downward"\` | Complete rendered child tree & props drilling detection. |
| **Upward Blast Radius** | \`get_component_tree\` | \`entry_path: "...", direction: "upward"\` | All parent components and pages impacted by modifying a leaf file. |
| **Route Map & Topology** | \`get_routes\` | \`targetPath?: "...", framework?: "next-app"|"nuxt"|"astro"|"inertia"\` | Instant file-based routing topology, layouts, dynamic parameters, and page handlers. |
| **Outbound API Contracts** | \`get_api_contracts\` | \`targetPath?: "..."\` | Maps API endpoints, HTTP methods, TanStack/Inertia/Axios network boundaries, and payload contracts. |
| **Trace State & Composables** | \`trace_state\` | \`identifier: "...", depth: 1|2+\` | Map consuming components for Pinia/Zustand stores, contexts, composables. |
| **Health, Duplication & APIs** | \`audit_frontend\` | \`target?: "all"|"routes"|"dead-components"|"dead-state"|"similar-templates"|"design-tokens"|"bundle-health"|"api-contracts"\` | Diagnostic manifest of dead components/state, duplicated templates, design token drift, hydration weight, and routes/APIs. |
| **Prescriptive Patch Plan** | \`generate_patch_plan\` | \`component_path: "...", refactor_type: "rename_prop", old_name: "...", new_name: "..."\` | Prescriptive AST patch recommendations (file, line, column, replacement snippet) across all consumers. |
| **Structural AST Search** | \`find_code\` | \`pattern: "..."\` or \`component: "..."\` | ast-grep pattern matches or component usage occurrences across repo. |

## Maximizing the Persistent Knowledge Graph (\`.strata/graph.db\`) & Realtime Watcher

Strata maintains a high-speed SQLite dependency graph at \`.strata/graph.db\` with native background realtime watching:

1. **Reactive Hot Cache Daemon**: Integrated native filesystem watcher (\`node:fs.watch\`) continuously updates the SQLite graph in the background (<100ms debounce), delivering instant hot cache hits (<1ms) without disk crawl overhead.
2. **Recursive Blast Radius Traversal**: When refactoring shared UI or utilities, run \`get_component_tree(direction: "upward")\`. Strata executes recursive Common Table Expressions (CTE) over the \`edges\` table, instantly uncovering every consumer without touching disk.
3. **Prescriptive Code Migrations**: Combine blast radius discovery with \`generate_patch_plan\` to obtain direct, deterministic AST patches across all affected consumers.
4. **Multi-Hop State Impact**: When altering a store or composable, use \`trace_state\` with \`depth: 2+\` to follow chained composable consumption across the graph.
5. **Direct SQLite Analytics (Advanced)**: The SQLite database at \`.strata/graph.db\` contains 5 indexed tables (\`files\`, \`components\`, \`edges\`, \`state_deps\`, \`routes\`). You can directly run SQL queries against it to extract custom architectural metrics (e.g., detecting "God Components" with high fan-out, critical foundation components with high fan-in, or finding orphan files).
`.trim();
