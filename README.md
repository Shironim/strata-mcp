# strata-mcp

> **Multi-Framework Frontend Structural AST Search, Component Graph & Intelligence Engine**  
> Precise AST-based structural code searching across **Vue SFCs (`.vue`)**, **Astro components (`.astro`)**, and **React/Next (`.js`, `.jsx`, `.ts`, `.tsx`)** with exact line-number remapping and persistent SQLite graph caching.

[![npm version](https://img.shields.io/npm/v/@dimassetoid/strata-mcp)](https://www.npmjs.com/package/@dimassetoid/strata-mcp)
[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?logo=bun&logoColor=white)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

Modern frontend development frequently spans **Vue/Nuxt**, **React/Next**, and **Astro Islands**, often interfaced with fullstack backends like Laravel Inertia or REST/GraphQL APIs. Developers and AI coding agents need deep structural intelligence (not just text regex) for tasks like:
- **Frontend-Backend Contract Drift**: *"Does my Vue `form.post('/cadets/store')` or TanStack Query mutation send payload keys (`cohort_year`) that match what the backend controller validates?"*
- **Silent Reactivity Bugs**: *"Did someone accidentally destructure reactive props (`const { user } = props`) or directly mutate props in a child component?"*
- **Context & Props Drift**: *"Which child components consume `inject('theme')` or `useContext()` without an active provider in the route layout hierarchy?"*
- **Component Adoption & Blast Radius**: *"Where is legacy `OldButton` still used, and if I change `BaseTable.vue`, which child components, layouts, and route pages are affected?"*
- **Route Topology & Dead Code**: *"What routes exist, which composables/stores have 0 external callers, and where do we have duplicate template clones?"*
- **Design Token & Bundle Bloat**: *"Are hardcoded `#hex` colors bypassing our Tailwind design system, and are heavy libraries (`echarts`) eagerly loaded on client islands?"*

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

> [!CAUTION]
> **Bun runtime is required.** This package uses `bun:sqlite` (a Bun built-in) and is compiled with `--target bun`. It **will crash if executed with Node.js**, even if `npm install` succeeds. Always use `bun` or `bunx` to run it.

```bash
# Recommended: install globally with Bun
bun add -g @dimassetoid/strata-mcp

# Or run directly without installing
bunx @dimassetoid/strata-mcp
```

> [!NOTE]
> **No extra setup needed on Linux (x64), Windows (x64), and macOS (Apple Silicon & Intel).**
> The `ast-grep` binary ships automatically via platform-specific optional dependencies
> (`@ast-grep/cli-*`, ast-grep 0.45.3) — `bun pm trust` is **not**
> required. On Windows, SmartScreen may prompt on first run; allow it.
> On other platforms, install ast-grep manually and point `AST_GREP_BIN` at the binary.

---

## MCP Client Configuration

Connect `strata-mcp` to your favorite AI agent:

### Claude Desktop / Claude Code (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "strata-mcp": {
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
    "strata-mcp": {
      "command": "bunx",
      "args": ["@dimassetoid/strata-mcp"]
    }
  }
}
```

---

## Available MCP Tools

`strata-mcp` exposes 5 unified, high-density MCP tools designed for maximum token efficiency and deep structural intelligence:

| Tool | Category | Description |
|---|---|---|
| `find_code(pattern?, component?, rule_yaml?, path?, language?)` | Code Search | Searches workspace code using AST patterns (`ast-grep`), relational YAML rules, or component adoption across `.vue`, `.astro`, and `.tsx`. For single-file inspection, use `inspect_component`. |
| `inspect_component(path, symbol?, audit_events?, infer_props?, resolve_globals?, output_format?)` | Contract Master | Deep component inspection (.vue, .tsx, .jsx, .astro). Extracts interface contracts (props/emits/slots), data fetching boundaries (Inertia, TanStack Query, Axios), form schemas & file uploads, reactivity smells, and slices symbols with blast radius. |
| `get_component_tree(entry_path?, route?, target_path?, max_depth?, direction?, scope_filter?, include_props?, output_format?)` | Architecture | Resolves component hierarchy trees from a file or route URL (`/dashboard`). Supports downward trees with props drilling (>2 levels) and dangling context alerts (provide/inject & useContext), or upward blast radius. |
| `trace_state(identifier, target_path?, depth?, role?, direction?, output_format?)` | State Architecture | Traces state store (Pinia, Zustand, Redux), Context, or composable impact across components. Identifies mutators vs readers and multi-hop cascading dependency chains. |
| `audit_frontend(target_path?, scope_path?, target?, threshold?, prefix?, framework?, ignore_patterns?, output_format?)` | System Audit | Architectural frontend health audit: file-based routes, dead components, unused state composables, structural template similarity, design tokens & a11y, and bundle health / island hydration. |

---

## High-Performance Architecture & Token Economy

1. **Frontend Contract Mastery**: Extracts exact ingress/egress boundaries (Inertia form actions, REST/Query endpoints, Ziggy routes) and form schemas so AI agents can align frontend contracts directly with backend controllers without manual browsing.
2. **Smart Path Resolver & Dynamic Imports**: Seamlessly resolves framework path aliases (`@/*`, `~/*`, `$lib/*`), implicit extensions (`.vue`, `.tsx`, `/index.*`), and lazy-loaded dynamic imports (`import()`, `defineAsyncComponent`, `React.lazy`).
3. **First-Class Diagnostics**: Directly surfaces props drilling alerts, reactivity smells (reactive destructuring loss), dangling context consumers, arbitrary color token usage, and heavy island hydration warnings.
4. **Fast-Path Candidate Pruning**: Keyword-based file pre-filtering bypasses expensive AST subprocess spawning for non-matching files, dropping search execution times by **97%** (from ~1,150ms to < 30ms, and < 2ms for non-existent symbols).
5. **Persistent SQLite Codebase Graph Cache**: Uses native `bun:sqlite` with WAL mode in `.strata/graph.db` to index components, edges, state dependencies, and routes with smart `mtime` delta synchronization (< 10ms warm sync) and instant SQL Recursive CTE blast radius queries.
6. **Strict Token Economy & Zero Raw Byte Dumping**: Returns high-density, structured summaries (< 80 tokens per contract) rather than dumping full multi-hundred-line components into the LLM context window.
7. **Engine Observability Metadata**: Every audit result surfaces its execution engine and duration badge (e.g. `[Engine: sqlite-graph-cache | 6ms]`); JSON output includes structured `_meta: { engine, durationMs, cached }` for programmatic inspection.

---

## CLI Companion Usage

You can run `strata` directly from the terminal without an MCP client:

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

# Aggregate routes by domain/module (useful for projects with 40+ routes)
strata routes ./src --view summary

# Filter routes by path prefix for focused inspection
strata routes ./src --prefix /admin
strata routes ./src --prefix /auth --json
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

# Include page files in the dead-code scan (alongside orphan components)
strata unused ./src --include-pages

# Output dead components as JSON (partitioned into orphanComponents + unreferencedPages)
strata unused ./src --json
```

### 8. Audit Unused State — Composables, Stores & Hooks
```bash
# Scan for composables, stores, hooks, and utils with zero external consumers
strata unused-state ./src

# Target a specific directory (e.g. Inertia composables)
strata unused-state ./resources/js/composables

# Output as structured JSON
strata unused-state ./src --json
```

### 9. Search AST Patterns Across Frameworks
```bash
# Search for Vue composables or functions
strata search "const $NAME = ref($$$)" --path ./src

# Search in React/TSX files
strata search "useEffect($$$, $$$)" --path ./src --lang tsx

# Search in Astro frontmatter
strata search "import $$$ from '$$$'" --path ./src
```

### 10. Test AST Rule in Memory Sandbox
```bash
strata rule ./rules/my-rule.yaml --path ./src
```

### 11. Dump CST Syntax Tree
```bash
strata dump "const count = ref(0);" --lang ts
```

---

## Real-World Prompt Example for AI Agents

Here are practical prompt scenarios where AI coding agents leverage `strata-mcp` to deliver zero-drift frontend engineering:

- **Fullstack Contract Alignment & Form Verification (`inspect_component`)**:
  > *"Inspect `CadetCreate.vue` to check its boundary contract — what endpoint does the form submit to, what payload keys does it send, and are there any multipart file uploads? Cross-reference them with our backend `CadetStoreRequest.php`."*

- **Upstream Blast Radius & Context Health (`get_component_tree`)**:
  > *"Resolve the component tree starting from URL route `/dashboard/cadets`. Check for props drilling (>2 levels) and identify any dangling context consumers (`inject` / `useContext`) missing a provider in ancestor layouts."*

- **Silent Reactivity & Anti-Pattern Audits (`inspect_component`)**:
  > *"Audit `OrderSummary.vue` for Vue 3 reactivity smells — specifically flag any reactive props destructuring, direct prop mutations, or uncleaned watch effects."*

- **Multi-Framework Component Migration (`find_code`)**:
  > *"Audit our project for migration from `OldButton` to `NewButton`. Check all `.vue`, `.astro`, and `.tsx` files (including dynamic `import()` boundaries and Astro islands) and list all remaining usages."*

- **Architectural Health & Dead Code Scans (`audit_frontend`)**:
  > *"Run an architectural audit across `./resources/js`: detect unused state composables, flag structural template copy-paste duplicates, and report hardcoded `#hex` colors bypassing our design system tokens."*


---

## License

MIT © 2026. Free for personal and commercial open-source use.
