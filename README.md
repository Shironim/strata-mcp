# Strata

> **Static & Semantic Code Analysis Engine for AI Coding Agents** — built for Frontend & Fullstack JS/TS projects.

[![npm version](https://img.shields.io/npm/v/@dimassetoid/strata-mcp)](https://www.npmjs.com/package/@dimassetoid/strata-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Strata is a local static and semantic analysis MCP server and CLI for Vue, Nuxt, React, Next.js, Svelte, and Astro codebases. Instead of grepping blindly or loading entire files into context, AI coding agents query an embedded SQLite symbol graph (`.strata/graph.db`) paired with a scoped TypeScript Language Service across single-repo apps, fullstack projects, monoliths, and monorepos—100% in-process with zero external binary dependencies.

---

## What It Does

Strata exposes **5 MCP tools** over the Model Context Protocol (MCP):

- **Workspace Mapping (`map_workspace`):** Maps project packages, frameworks, routes, file inventories, and unused candidates without reading file bodies.
- **File Outline & Contract (`inspect_file`):** Extracts body-free symbol outlines, type-resolved props, emits, slots, render boundaries, and outbound HTTP calls.
- **Unified Graph & Impact (`query_graph`):** Traces `definition`, `references`, `call_hierarchy`, `component_tree`, `state_flow`, and `impact` across files and packages, grouping results by package and flagging dynamic omissions.
- **Selective Source Reading (`read_slice`):** Reads bounded, SHA-256 hash-verified slices by `source_ref`, `symbol_id`, SFC block, or line range with stale-file and workspace-boundary guards.
- **In-Process Code Discovery (`search_code`):** Searches workspace symbols, `component_usage`, `prop_usage`, and scoped literal text without spawning external processes.

### Supported Frameworks

| Framework | Extensions | Capabilities |
|---|---|---|
| **Vue.js (2 & 3)** | `.vue`, `.ts`, `.js` | Props, emits, slots, v-model, Composition & Options API, Pinia stores |
| **Nuxt.js** | `.vue`, `.ts`, `.js` | File-system routing (`pages/`), layouts (`layouts/`), server routes (`server/api/`), composables (`$fetch`, `useAsyncData`) |
| **React.js** | `.tsx`, `.jsx`, `.ts`, `.js` | Function & class components, JSX elements, React hooks (`useState`, `useReducer`), Context & Zustand stores |
| **Next.js** | `.tsx`, `.jsx`, `.ts`, `.js` | App Router (`app/**`), Pages Router (`pages/**`), Server & Client components (`'use client'`), API routes |
| **Astro** | `.astro`, `.ts`, `.js` | Islands architecture (`client:*` directives), component imports, frontmatter props & slots |
| **Svelte (4 & 5)** | `.svelte`, `.ts`, `.js` | Svelte 5 Runes (`$state`, `$derived`, `$props`, `$bindable`), Svelte 4 reactive statements (`$:`), SvelteKit routes (`+page.svelte`, `+server.ts`) |

> **Static Analysis Scope:** Strata analyzes source files and configuration statically—it does not execute the application or guarantee exhaustive runtime coverage. Dynamic expressions, forwarding, and runtime behavior still require verification in your project. See the [Feature Contracts & Limits](docs/features/README.md) for full tool contracts, response budgets, and known limits.

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

Run `strata init` in your project root to set up `.strata/graph.db`, MCP configs, and agent skills:

```bash
strata init
```

You can target a specific AI harness directly:

```bash
strata init --harness antigravity   # Google Antigravity (.gemini/)
strata init --harness claude        # Claude Code (.claude/)
strata init --harness codex         # OpenAI Codex (.codex/)
strata init --harness opencode      # OpenCode (opencode/)
strata init --harness agents        # Universal Agent Harness (.agents/)
```

---

## CLI Reference

### Operational Commands

| Command | Description |
|---|---|
| `strata serve` | Start the MCP server over stdio for AI coding agents |
| `strata init [dir]` | Initialize `.strata/graph.db`, MCP configs, and agent skills |
| `strata sync [dir]` | Incrementally update `.strata/graph.db` with file changes |
| `strata stats [dir]` | View local MCP telemetry (latency, request counts, errors) |

### Analysis Commands (1:1 with MCP Tools)

| Command | Description |
|---|---|
| `strata map [dir]` | Map projects, frameworks, routes, files, or health candidates |
| `strata inspect <file>` | Inspect file outline, resolved props/slots contract, and HTTP boundaries |
| `strata graph <query> [file]` | Query `definition`, `references`, `call_hierarchy`, `component_tree`, `state_flow`, or `impact` |
| `strata read [file]` | Read a bounded, hash-verified source slice (`--ref`, `--symbol-id`, `--symbol`, `--block`, `--lines`) |
| `strata search <query>` | Search symbols, `component_usage`, `prop_usage`, or scoped text |

---

## Documentation

- [Feature Contracts & Limits](docs/features/README.md) — Tool specifications, index requirements, and static-analysis boundaries
- [Retrieval Evidence & Response Budgets](docs/features/retrieval-evidence-contract.md) — Formats, `max_bytes` pagination, summary mode, and evidence metadata
- [Storage & Monorepo Sync](docs/features/storage-and-monorepo-sync.md) — SQLite WAL cache (`.strata/graph.db`) and incremental sync
- [Semantic Engine & Plugins](docs/features/semantic-engine-and-plugins.md) — Framework plugins, Virtual TSX projection, and TypeScript Language Service lifecycle

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
