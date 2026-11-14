# Strata

> **Frontend Structural Analysis & Component Graph Engine for AI Coding Agents.**

[![npm version](https://img.shields.io/npm/v/@dimassetoid/strata-mcp)](https://www.npmjs.com/package/@dimassetoid/strata-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Strata provides structural code search, component dependency graphs, and route mapping for frontend applications: **Vue**, **Nuxt**, **React**, **Next.js**, **Astro**, and **Svelte**.

Strata extracts component contracts, state dependencies, routes and API endpoints from source. Tools return the selected analysis or source regions, with scope and coverage metadata. Indexed analyses use an embedded SQLite cache (`.strata/graph.db`).

---

## Supported Frameworks

| Framework | Extensions | Capabilities |
|---|---|---|
| **Vue.js (2 & 3)** | `.vue`, `.ts`, `.js` | Props, emits, slots, v-model, Composition & Options API, Pinia stores |
| **Nuxt.js** | `.vue`, `.ts`, `.js` | File-system routing (`pages/`), layouts (`layouts/`), server routes (`server/api/`), composables (`$fetch`, `useAsyncData`) |
| **React.js** | `.tsx`, `.jsx`, `.ts`, `.js` | Function & class components, JSX elements, React hooks (`useState`, `useReducer`), Context & Zustand stores |
| **Next.js** | `.tsx`, `.jsx`, `.ts`, `.js` | App Router (`app/**`), Pages Router (`pages/**`), Server & Client components (`'use client'`), API routes |
| **Astro** | `.astro`, `.ts`, `.js` | Islands architecture (`client:*` directives), component imports, frontmatter props & slots |
| **Svelte (4 & 5)** | `.svelte`, `.ts`, `.js` | Svelte 5 Runes (`$state`, `$derived`, `$props`, `$bindable`), Svelte 4 reactive statements (`$:`), SvelteKit routes (`+page.svelte`, `+server.ts`) |

---

## Installation

### Standalone Binary (Zero Dependencies)

Download and install the compiled single binary without needing Node.js or Bun installed locally:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.ps1 | iex
```

### Via Bun Package Manager

```bash
bun add -g @dimassetoid/strata-mcp
```

*(You can also run commands directly with `bunx @dimassetoid/strata-mcp <command>`)*

---

## Quick Start & AI Agent Setup

Run `strata init` in your project root to set up MCP configuration and AI agent skills:

```bash
strata init
```

Every `strata init` rebuilds the complete graph index in `.strata/graph.db`, including unchanged source files. Run it again after local parser changes. Normal `strata sync` remains incremental; release compatibility follows the Strata package version without a separate cache revision counter.

You can target a specific AI harness directly:

```bash
strata init --harness antigravity   # Google Antigravity (.gemini/)
strata init --harness claude         # Claude Code (.claude/)
strata init --harness codex          # OpenAI Codex (.codex/)
strata init --harness opencode       # OpenCode (opencode/)
strata init --harness agents         # Universal Agent Harness (.agents/)
```

---

## MCP Tools Reference

Strata provides 6 tools via the Model Context Protocol (MCP):

| Tool | Description |
|---|---|
| **`find_code`** | Search structural code patterns across templates and scripts without loading entire files into context |
| **`inspect_component`** | Extract public component interfaces (props, emits, slots, state) and retrieve specific code slices |
| **`get_component_tree`** | Inspect component hierarchies and discovered caller candidates within the analyzed scope |
| **`trace_state`** | Find static state references and reader/mutator candidates within the analyzed scope |
| **`audit_frontend`** | Scan application routes, outbound HTTP API calls, and detect unused reactive state |
| **`generate_patch_plan`** | Generate hash-bound proposals for supported static prop, event, model, and slot usages; review coverage and verify after editing |

---

## CLI Reference

### Common Commands

| Command | Description |
|---|---|
| `strata serve` | Start the MCP server over stdio for AI coding agents |
| `strata init [dir]` | Initialize agent rules and skills, and rebuild the complete graph index |
| `strata sync [dir]` | Update the `.strata/graph.db` index with file changes |
| `strata stats [dir]` | View MCP performance telemetry (latency, request counts, errors) |

### Analysis Commands

| Command | Description |
|---|---|
| `strata find <pattern>` | Search code patterns across `.vue`, `.svelte`, `.astro`, `.tsx`, `.jsx`, `.ts`, `.js` |
| `strata inspect <file>` | Inspect component props, emits, slots, and state |
| `strata tree [entry]` | View component hierarchy tree or dependent callers (`--direction upward`) |
| `strata trace <state-name>` | Trace where a reactive state or store is used |
| `strata routes [dir]` | List application routes and page mappings |
| `strata apis [dir]` | List outbound HTTP API calls and their caller components |
| `strata dead-state [dir]` | Find unused reactive state composables or stores |
| `strata patch <file>` | Generate refactoring plans for prop or event renames |

---

## Project Documentation

Start with the [feature documentation](docs/features/README.md) for feature requirements, Single Source of Truth (SSOT) specifications, architectural design, and retrieval contracts.

## Development

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
