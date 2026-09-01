# strata-mcp

> **Multi-Framework Frontend Structural AST Search, Component Graph & Intelligence Engine**  
> Precise AST-based structural code searching across **Vue SFCs (`.vue`)**, **Astro components (`.astro`)**, and **React/Next (`.js`, `.jsx`, `.ts`, `.tsx`)** with exact line-number remapping and persistent SQLite graph caching.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

Modern frontend development frequently spans **Vue/Nuxt**, **React/Next**, and **Astro Islands**. Developers and AI coding agents need deep structural intelligence (not just text regex) for tasks like:
- **Component Adoption Audits**: *"Where is legacy `OldButton` still used, and which pages haven't migrated to `NewButton`?"*
- **Upward Blast Radius**: *"If I change `BaseTable.vue`, which child components, layouts, and route pages are affected?"*
- **Route Topology Mapping**: *"What routes, layouts, and API handlers exist across Next.js, Nuxt 3, Astro, or Inertia?"*
- **State Impact Tracing**: *"Which components and pages consume `useCartStore` or `ThemeContext`?"*
- **Astro Island Auditing**: *"Which Vue and React components are embedded in `.astro` pages, and which ones are hydrated client-side (`client:load`, `client:visible`)?"*

Existing AST tools like [ast-grep](https://ast-grep.github.io) are powerful for `.js/.jsx/.ts/.tsx`, but **fail on multi-language documents like `.vue` and `.astro`** because they treat entire files as HTML, breaking JavaScript/TypeScript AST parsing inside `<script>` and frontmatter (`---`) blocks.

---

## How `strata-mcp` Solves It

```
.vue / .astro / .tsx file
   │
   ▼
[Document Splitter]  ← @vue/compiler-sfc parse() / Astro frontmatter parser
   │
   ├── script / frontmatter block ──► [ast-grep engine] ──► matches (relative coordinates)
   │                                                            │
   ├── template / JSX block ───────► [compiler-dom AST] ─► matches (relative coordinates + directives)
   │
   ▼
[Offset Remapper]  ← Remaps block-relative line/col back to original file line numbers
   │
   ▼
[Persistent SQLite Graph] (.strata/graph.db) ← Bun SQLite WAL mode, smart mtime delta sync (<10ms)
   │
   ▼
[MCP / CLI Response] ← Token-efficient summary (file:line:col [client:directive] - snippet)
```

1. **Multi-Language Document Splitting**: Separates `<template>`, `<script>`, `<script setup>`, and Astro frontmatter (`---`) with 100% offset fidelity.
2. **Native JS/TS AST Matching**: Runs `ast-grep` on script and frontmatter blocks (supporting metavariables like `$VAR`, `$$$`, and relational rules `inside`, `has`, `not`).
3. **Advanced Import Recognition**: Automatically detects static imports, dynamic/lazy imports (`defineAsyncComponent`, `React.lazy`, `next/dynamic`), and barrel re-exports (`export { default as Component }`).
4. **Local Alias & Namespace Linking**: Tracks aliased imports (`import { X as Y }`) and namespace calls (`<UI.X />`), automatically resolving `<Y />` in templates back to `X`.
5. **Astro Island Directives**: Detects hydration directives (`client:load`, `client:visible`, `client:only`) and surfaces them directly in search results.
6. **Exact Line Remapping**: Calculates the exact line and column numbers in the original `.vue` or `.astro` file.
7. **Persistent SQLite Graph Cache**: Stores component hierarchies, render boundaries, state dependencies, and routes in `.strata/graph.db` with sub-millisecond CTE queries.
8. **Zero Token Flooding**: Outputs concise, line-oriented text by default (JSON optional).

---

## Installation

Requires **[Bun](https://bun.sh)** (`>= 1.1.0`) for high-performance AST processing and native `bun:sqlite` graph caching.

```bash
bun add -g @dimassetoid/strata-mcp
# or run directly via bunx
bunx @dimassetoid/strata-mcp
```

> **Lifecycle scripts**: When installing `@ast-grep/cli` with Bun, ensure lifecycle scripts are trusted:
> `bun pm trust @ast-grep/cli`

---

## MCP Client Configuration

Connect `strata-mcp` to your favorite AI agent:

### Claude Desktop / Claude Code (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "strata": {
      "command": "bunx",
      "args": ["@dimassetoid/strata-mcp"]
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`) / VSCode
```json
{
  "mcpServers": {
    "strata": {
      "command": "bunx",
      "args": ["@dimassetoid/strata-mcp"]
    }
  }
}
```

---

## Available MCP Tools

| Tool | Category | Description |
|---|---|---|
| `find_code(pattern, path, language?, max_results?)` | Code Search | Searches code using `ast-grep` patterns with line remapping across `.vue`, `.astro`, and `.ts/.tsx`. Accelerated by Fast-Path Pruning. |
| `find_code_by_rule(rule_yaml, path, max_results?)` | Code Search | Searches code using complex YAML rules with relational constraints (`inside`, `has`, `not`). |
| `find_component_usage(component_name, path, scope?)` | Adoption Audit | Scans component imports in script/frontmatter and tag usages in template/JSX across multi-casing (kebab & Pascal). |
| `dump_syntax_tree(code, language?)` | AST Helper | Dumps the CST syntax tree of a code snippet for AST pattern debugging. |
| `test_match_code_rule(rule_yaml, code_snippet)` | Rule Sandbox | Validates a YAML rule against an in-memory code snippet without touching disk (< 20ms). |
| `extract_component_contract(path, output_format?)` | Token Economy | Extracts component interface (`props`, `emits`, `slots`, `exposed`, render boundary, and state dependencies) with > 94% token savings. |
| `get_component_tree(entry_path, max_depth?, direction?, output_format?)` | Architecture | Maps downward or upward component hierarchy trees (call graph / blast radius) with auto-import and alias resolution. |
| `find_unused_components(target_path, ignore_patterns?, output_format?)` | Dead Code Audit | Two-pass in-memory audit to identify orphan/dead components (0 usages) across the entire monorepo. |
| `scan_routes(target_path, framework?, output_format?)` | Routing | Discovers file-based route topology, dynamic parameters, nested layouts, and API handlers (Next.js, Nuxt 3, Astro, Inertia). |
| `query_state_impact(identifier, target_path?, output_format?)` | State Architecture | Traces all components, layout wrappers, and pages consuming a specific state store (Pinia, Zustand, Redux), Context, or composable. |

---

## High-Performance Architecture & Token Economy

1. **Fast-Path Candidate Pruning (Engine B)**: Keyword-based file pre-filtering bypasses expensive AST subprocess spawning for non-matching files, dropping search execution times by **97%** (from ~1,150ms to < 30ms, and < 2ms for non-existent symbols).
2. **Persistent SQLite Codebase Graph Cache (Engine A)**: Uses native `bun:sqlite` with WAL mode in `.vue-ast/graph.db` to index components, edges, state dependencies, and routes with smart `mtime` delta synchronization (< 10ms warm sync) and instant SQL Recursive CTE blast radius queries.
3. **Strict Token Economy**: Instead of dumping full 1,500-line components into the LLM context window, `extract_component_contract` delivers high-density interface summaries (< 80 tokens), preserving context window limits.

---

## CLI Companion Usage

You can also run `strata` directly from the terminal without an MCP client (`vue-ast` is also supported as a backward-compatible alias):

### 1. Audit Component Adoption (Vue, React, Astro)
```bash
# Find all usages of OldButton across .vue, .astro, and .tsx files
strata find-component-usage OldButton --path ./src

# Output as structured JSON (including clientDirective metadata)
strata find-component-usage OldButton --path ./src --json
```

### 2. Extract Component Contract (Token-Efficient Interface)
```bash
# Extract props, emits, slots, and render boundaries
strata contract ./src/components/ProductCard.vue

# Output as JSON contract
strata contract ./src/components/ProductCard.vue --json
```

### 3. Visualize Downward Component Hierarchy Tree
```bash
# Generate indented call graph tree starting from root view/page
strata tree ./src/views/CatalogView.vue --depth 3

# Trace Upward Blast Radius (consumers up to pages)
strata tree ./src/components/OldButton.vue --direction upward

# Output tree as JSON hierarchy
strata tree ./src/views/CatalogView.vue --depth 3 --json
```

### 4. Scan File-Based Route Topology (Next.js, Nuxt 3, Astro, Inertia)
```bash
# Scan routing topology, dynamic parameters, layouts, and API handlers
strata routes ./src

# Scan with explicit framework hint and JSON output
strata routes . --framework inertia --json
```

### 5. Query State & Composable Impact (SQLite Graph)
```bash
# Trace all components, layout wrappers, and pages consuming a state store or composable
strata impact useForm --path ./resources/js

# Query Pinia or Zustand store consumers
strata impact useCartStore --path ./src
```

### 6. Workspace Graph Delta Synchronization
```bash
# Manually synchronize local SQLite graph cache (.strata/graph.db)
strata sync ./src
```

### 7. Audit Unused / Dead Components
```bash
# Scan project for components with 0 usages (ignoring pages and stories)
strata unused ./src --ignore "**/pages/**,**/*.stories.*"

# Output dead components as JSON
strata unused ./src --json
```

### 8. Search AST Patterns Across Frameworks
```bash
# Search for Vue composables or functions
strata search "const $NAME = ref($$$)" --path ./src

# Search in React/TSX files
strata search "useEffect($$$, $$$)" --path ./src --lang tsx

# Search in Astro frontmatter
strata search "import $$$ from '$$$'" --path ./src
```

### 9. Test AST Rule in Memory Sandbox
```bash
strata rule ./rules/my-rule.yaml --path ./src
```

### 10. Dump CST Syntax Tree
```bash
strata dump "const count = ref(0);" --lang ts
```

---

## Real-World Example: Multi-Framework Adoption Audit

Prompt to your AI Assistant:
> *"Audit our project for migration from `OldButton` to `NewButton`. Check all `.vue`, `.astro`, and `.tsx` files and list which pages still use `OldButton` (including dynamic imports and Astro islands) and which ones are already migrated."*

The assistant uses `find_component_usage` and returns:
```text
src/pages/Checkout.vue:4:5 - <OldButton label="Pay Now" />
src/pages/Landing.astro:9:5 [client:visible] - <OldButton client:visible />
src/pages/Dashboard.tsx:3:1 - const OldButton = React.lazy(() => import('./OldButton'))
src/components/Barrel.ts:1:1 - export { default as OldButton } from './OldButton.vue'
src/pages/Migrated.vue:5:5 - <NewButton variant="primary">Migrated</NewButton>
```

---

## License

MIT © 2026. Free for personal and commercial open-source use.
