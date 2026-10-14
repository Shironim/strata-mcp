# Strata

> **Multi-Framework Frontend Structural AST Search, Component Graph & Intelligence Engine.**

[![npm version](https://img.shields.io/npm/v/@dimassetoid/strata-mcp)](https://www.npmjs.com/package/@dimassetoid/strata-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Strata delivers token-efficient structural code intelligence across **Vue SFCs (`.vue`)**, **Astro (`.astro`)**, and **React/Next (`.js`, `.jsx`, `.ts`, `.tsx`)**. It indexes component hierarchies, state dependencies, and routes into an embedded SQLite graph cache (`.strata/graph.db`) with exact multi-language line remapping.

---

## Installation

Install Strata globally using [Bun](https://bun.sh):

```bash
bun add -g @dimassetoid/strata-mcp
```

> **Note:** You can also run commands on-the-fly without global installation using `bunx @dimassetoid/strata-mcp <command>`.

---

## Quick Start

### 1. Initialize in Any Project

```bash
strata init
# or zero-install via bunx:
bunx @dimassetoid/strata-mcp init
```
*Bootstraps agent harness rules/skills and initializes local SQLite graph cache (`.strata/graph.db`).*

### 2. Connect to AI Agent (MCP Server)

Add Strata to your MCP client (`mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "strata": {
      "command": "strata",
      "args": ["serve"]
    }
  }
}
```
*(Or use `"command": "bunx", "args": ["@dimassetoid/strata-mcp", "serve"]` if running without global installation).*

---

## CLI Reference

| Command | Description |
|---|---|
| `strata serve` | Launch stdio MCP server for AI coding agents |
| `strata init [path]` | Bootstrap agent harness rules/skills & initialize graph cache |
| `strata contract <file>` | Extract token-efficient component interface (props, emits, slots) |
| `strata tree [file] [--route <path>]` | Visualize downward component hierarchy or upward blast radius |
| `strata routes [path]` | Map file-based route topology, layouts, and dynamic parameters |
| `strata impact <symbol>` | Query state store, composable, or context blast radius across components |
| `strata apis [path]` | Extract outbound HTTP API calls, methods, and payload schemas |
| `strata audit [path] [--target <t>]` | Audit frontend health (`dead-components`, `dead-state`, `routes`, `similar-templates`, `design-tokens`, `bundle-health`, `api-contracts`, `archetype-drift`, or `all`) |
| `strata archetype <file>` | Audit page archetype & structural drift against exemplar |
| `strata unused [path]` | Audit dead/unreferenced components and pages |
| `strata unused-state [path]` | Scan for composables, stores, and hooks with zero consumers |
| `strata search <pattern>` | Search multi-framework AST patterns with metavariables (`ast-grep`) |
| `strata patch-plan <file>` | Generate prescriptive AST patch plan across upward consumers |
| `strata sync [path]` | Fast incremental delta synchronization for `.strata/graph.db` |
| `strata stats [path]` | Display MCP tool latency percentiles (p50/p95), error rates, and items found |

---

## Core Capabilities & MCP Tools

All 6 tools expose typed schemas automatically via the Model Context Protocol:

- **Structural Code Search (`find_code`):** Multi-framework AST search across `.vue`, `.astro`, and `.tsx` with exact line remapping.
- **Component Contract Master (`inspect_component`):** Deep inspection of props, emits, slots, dynamic layout styling tokens (Tailwind flex/grid/:class), and **Bidirectional Data Transport Contract** (detects casing mismatches, FormData nested object hazards, pagination traps, unguarded nullability, Zod validation schemas, 422 error audits, and cache invalidation graphs).
- **Hierarchy & Blast Radius (`get_component_tree`):** Resolves downward trees (with props drilling & dangling context alerts) or upward blast radius (`downward`/`down` or `upward`/`up`).
- **Prescriptive Refactoring (`generate_patch_plan`):** Generates exact AST-level replacement diffs across all upward callers (`rename_prop`, `remove_prop`, `rename_event`, `rename_model`, `rename_slot`).
- **State Impact Tracer (`trace_state`):** Maps state stores (Pinia, Zustand, Redux), composables, and Context cascading chains (`consumers`, `dependencies`, `both`).
- **Full Frontend Audit (`audit_frontend`):** Route topology (`target: "routes"`, `view: "summary" | "full" | "tree"`), outbound API calls and inferred backend candidates (`target: "api-contracts"`), plus health checks for dead components, unused state, template clones, design tokens, bundle health, API contracts, and page archetype drift.

---

### Migration to six MCP tools

Use `audit_frontend(path: "/absolute/project", target: "routes", view: "summary")` instead of `get_routes`, and `audit_frontend(path: "/absolute/project", target: "api-contracts", scope_path: "src")` instead of `get_api_contracts`. The two old tool names and tool-definition exports have been removed; no hidden compatibility tools are registered. Route/API engines and library exports remain available, as do CLI commands `strata routes` and `strata apis`.

Rebuild and restart your MCP client to load the six-tool catalog. Generated agent rules and skills should be reviewed and updated with the routing above; `strata init --force` replaces existing generated artifacts, so preserve custom instructions before using it.

## Development & Contributing

```bash
# Clone and install dependencies
git clone https://github.com/Shironim/strata-mcp.git
cd strata-mcp
bun install

# Run test suite & build
bun test
bun run build
```

---

## License

[MIT](LICENSE) © shironim

### Exact text search and missing component paths

`find_code` defaults to structural AST search. For exact text such as an asset reference, use:

```json
{"path":"/absolute/project","pattern":"transformer.webp","mode":"literal"}
```

`literal` returns one match per matching source line, uses case-sensitive substrings, and does not interpret regex escapes. Directory scans keep the collector's source-file extensions and ignore rules; this is not an asset-filename or all-file search. `mode: "auto"` tries AST matching and falls back only for invalid AST patterns, never for missing binaries or general execution failures. Specify `language` when the pattern needs a particular parser, such as `tsx`.

Snippet pattern searches default to the TypeScript parser; specify `language: "tsx"`, `"jsx"`, or `"html"` for those syntaxes. Explicit `language: "auto"` uses a tag heuristic and can interpret TypeScript angle-bracket assertions as HTML. YAML rules define their own language. Searches default to 200 returned matches; `max_results` also applies to YAML snippets.

`format: "text"` is the default for disk and snippet searches. Text fallback output includes a notice, and snippet results use `<snippet>:line:column` coordinates. With `format: "json"`, disk searches return an array and snippets return `{ matchCount, matches }`; `matchCount` counts returned matches after limiting. Pattern responses include MCP `structuredContent` with `modeRequested`, `modeUsed`, and `fallbackReason` when applicable. YAML rules, component adoption, and CST dumps do not use pattern-mode metadata; `auto`/`literal` modes cannot be used for those operations.

For a missing `inspect_component` path, Strata suggests up to five paths with the same case-sensitive name **without the extension** within the inferred project or explicit `project_root`. Explicit roots need no project marker; inferred roots do. Requests outside that root receive no suggestions. The not-found error remains, and no candidate is inspected automatically. Retry with the intended path; multiple candidates remain ambiguous.
