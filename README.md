# Strata

> **Frontend Structural Analysis & Component Graph Engine for AI Coding Agents.**

[![npm version](https://img.shields.io/npm/v/@dimassetoid/strata-mcp)](https://www.npmjs.com/package/@dimassetoid/strata-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Strata is a local static-analysis MCP server and CLI for frontend codebases. Instead of grepping blindly or loading entire component files into context, AI coding agents query an embedded SQLite component graph (`.strata/graph.db`) and AST engine to inspect component contracts, trace reactive state, map routes and API calls, and generate hash-bound refactoring plans.

---

## What It Does

Strata exposes 6 focused tools over the Model Context Protocol (MCP):

- **Structural Search & Inventory (`find_code`):** Inventories project files and searches templates or scripts using ast-grep patterns, relational YAML rules, literal text, or component/prop usage selectors without loading full files into context.
- **Component Contracts & Slicing (`inspect_component`):** Extracts public component interfaces (props, emits, slots, models, state dependencies, and outbound API boundaries) and retrieves exact source ranges or symbol slices with SHA-256 verification.
- **Component Hierarchy & Callers (`get_component_tree`):** Traverses downward rendered children or upward consumer candidates from a component or URL route, reporting prop forwarding and context dependencies (`provide`/`inject`, `useContext`, `setContext`).
- **State & Store Impact (`trace_state`):** Finds static readers and mutators for Pinia, Zustand, Context, and composables, and traces bounded dependency chains.
- **Frontend Audits (`audit_frontend`):** Scans application routes, outbound HTTP API calls, and unused component or reactive-state candidates.
- **Safe Refactoring Proposals (`generate_patch_plan`):** Generates hash-bound edit proposals for static prop, event, model, and slot renames or removals across consumer files.

### Supported Frameworks

| Framework | Extensions | Capabilities |
|---|---|---|
| **Vue.js (2 & 3)** | `.vue`, `.ts`, `.js` | Props, emits, slots, v-model, Composition & Options API, Pinia stores |
| **Nuxt.js** | `.vue`, `.ts`, `.js` | File-system routing (`pages/`), layouts (`layouts/`), server routes (`server/api/`), composables (`$fetch`, `useAsyncData`) |
| **React.js** | `.tsx`, `.jsx`, `.ts`, `.js` | Function & class components, JSX elements, React hooks (`useState`, `useReducer`), Context & Zustand stores |
| **Next.js** | `.tsx`, `.jsx`, `.ts`, `.js` | App Router (`app/**`), Pages Router (`pages/**`), Server & Client components (`'use client'`), API routes |
| **Astro** | `.astro`, `.ts`, `.js` | Islands architecture (`client:*` directives), component imports, frontmatter props & slots |
| **Svelte (4 & 5)** | `.svelte`, `.ts`, `.js` | Svelte 5 Runes (`$state`, `$derived`, `$props`, `$bindable`), Svelte 4 reactive statements (`$:`), SvelteKit routes (`+page.svelte`, `+server.ts`) |

> **Static Analysis Scope:** Strata analyzes source files and configuration statically—it does not execute the application or guarantee exhaustive runtime coverage. Dynamic expressions, forwarding, and runtime behavior still require verification in your project. See [feature documentation](docs/features/README.md) for full tool contracts, response budgets, and known limits.

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

Run `strata init` in your project root to set up MCP configuration, agent skills, and the `.strata/graph.db` index:

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

### Common Commands

| Command | Description |
|---|---|
| `strata serve` | Start the MCP server over stdio for AI coding agents |
| `strata init [dir]` | Initialize agent rules and skills, and build the graph index |
| `strata sync [dir]` | Incrementally update `.strata/graph.db` with file changes |
| `strata stats [dir]` | View local MCP telemetry (latency, request counts, errors) |

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

## Documentation

- [Feature Contracts & Limits](docs/features/README.md) — Tool specifications, index requirements, and static-analysis boundaries
- [Retrieval Evidence & Response Budgets](docs/features/retrieval-evidence-contract.md) — Formats, `max_bytes` pagination, summary mode, and evidence metadata
- [Storage & Delta Sync](docs/features/storage-and-delta-sync.md) — SQLite WAL cache (`.strata/graph.db`) and incremental invalidation

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
