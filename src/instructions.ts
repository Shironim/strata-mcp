export const STRATA_INSTRUCTIONS = `# Strata MCP — Static and Semantic Code Analysis
Static AST and TypeScript semantic analysis for Vue, Nuxt, React, Next.js, Svelte, and Astro across single-repo, monolith, fullstack JS/TS, and monorepo workspaces. Read-only; never mutates source files.

## Recommended Workflow (Map -> Inspect -> Query Graph -> Read Slice)
1. **Map (\`map_workspace\`)**: Start with \`view: "overview"\`, \`"packages"\`, \`"routes"\`, or \`"files"\` to inspect project structure, frameworks, and routes without reading file bodies.
2. **Inspect (\`inspect_file\`)**: Inspect a file's symbol outline, TypeChecker-resolved props/slots contract, render boundary, and outbound HTTP boundaries (body-free).
3. **Query Graph (\`query_graph\`)**: Use \`definition\`, \`references\`, \`call_hierarchy\`, \`component_tree\`, \`state_flow\`, or \`impact\` to trace relationships and refactor sites across files and packages.
4. **Read Slice (\`read_slice\`)**: Read only the needed symbol or range using \`source_ref\` or \`symbol_id\` handles from previous calls. Never invent line numbers.
5. **Search (\`search_code\`)**: When the file or symbol is unknown, search via \`kind: "symbol"\`, \`"component_usage"\`, \`"prop_usage"\`, or \`"text"\`.

## Boundaries & Evidence Discipline
- **Grouped Summaries**: On large workspaces, inspect \`SUMMARY BY PACKAGE\` first and narrow with \`scope.packages\` or \`cursor\`.
- **Evidence Transparency**: Check \`VERIFICATION: tier=graph|semantic|syntax-fallback\` and manually verify every item listed under \`OMISSIONS\` (such as dynamic spreads \`v-bind\` / \`{...props}\`).
- **Default Format**: \`format: "text"\` is compact and token-efficient; pass \`format: "json"\` only when structured JSON is required.
`.trim();
