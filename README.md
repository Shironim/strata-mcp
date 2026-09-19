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
| `strata unused [path]` | Audit dead/unreferenced components and pages |
| `strata unused-state [path]` | Scan for composables, stores, and hooks with zero consumers |
| `strata search <pattern>` | Search multi-framework AST patterns with metavariables (`ast-grep`) |
| `strata patch-plan <file>` | Generate prescriptive AST patch plan across upward consumers |
| `strata sync [path]` | Fast incremental delta synchronization for `.strata/graph.db` |

---

## Core Capabilities & MCP Tools

All tools expose typed schemas automatically via the Model Context Protocol:

- **Structural Code Search (`find_code`):** Multi-framework AST search across `.vue`, `.astro`, and `.tsx` with exact line remapping.
- **Component Contract Master (`inspect_component`):** Deep inspection of props, emits, slots, form schemas, Inertia/Query endpoints, and reactivity smells.
- **Hierarchy & Blast Radius (`get_component_tree`):** Resolves downward trees (with props drilling & dangling context alerts) or upward blast radius.
- **Route Discovery (`get_routes`):** Maps route topology, layouts, and dynamic parameters across Next.js, Nuxt, Astro, and Inertia.
- **API Boundary Extraction (`get_api_contracts`):** Extracts and canonicalizes outbound HTTP endpoints (`/api/users/:id`) and payload keys.
- **Prescriptive Refactoring (`generate_patch_plan`):** Generates exact AST-level replacement diffs across all upward callers.
- **State Impact Tracer (`trace_state`):** Maps state stores (Pinia, Zustand, Redux), composables, and Context cascading chains.
- **Full Frontend Audit (`audit_frontend`):** Comprehensive health check for dead components, unused state, template clones, and design tokens.

---

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
