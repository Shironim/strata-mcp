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

### Option 1: Standalone Binary (Zero Dependencies — Linux, macOS, Windows)

Install the compiled single-file binary directly without needing Bun or Node.js:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.ps1 | iex
```

### Option 2: Via Bun Package Manager

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
*Bootstraps agent harness rules/skills (Gemini/Antigravity, Claude, Cursor, Codex, OpenCode, Goose, Pi) and initializes local SQLite graph cache (`.strata/graph.db`).*

Use `--harness <name>` or `--agent <name>` to target a specific agent harness, `-f, --force` to overwrite existing configuration files, and `-y, --yes` to accept defaults automatically.

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

### Operational Commands

| Command | Description |
|---|---|
| `strata serve` | Launch stdio MCP daemon server for AI coding agents |
| `strata init [dir] [options]` | Bootstrap agent harness rules/skills & initialize graph cache (`--harness`, `-f, --force`, `-y, --yes`) |
| `strata sync [dir]` | Fast incremental delta synchronization for `.strata/graph.db` |

### Core Analytical Commands (Aligned with 6 MCP Tools)

| Command | Primary Aliases | Description & Key Options |
|---|---|---|
| `strata find --map [dir]` | — | Bounded frontend inventory without source bodies. Options: `--limit <n>`, `--offset <n>`, `--exclude-dirs <dirs>` |
| `strata find <pattern>` | `search`, `usage`, `rule` | AST structural code search across `.vue`, `.astro`, `.tsx`, `.jsx`, `.ts`, `.js`. Options: `--component <name>`, `--rule <yaml>`, `--lang <hint>`, `--scope <template\|script\|both>`, `--mode <ast\|auto\|literal>` |
| `strata inspect <file> --view map` | `contract` | Exact parser/AST regions, line coordinates, hash-bound source refs, diagnostics, and coverage. `--limit <n>` bounds top-level symbols. |
| `strata inspect <file> --view source --source-ref <json>` | `contract` | Retrieves a raw source slice from a ref returned by map; rejects stale file content. `--source-range <start:end>` supports inclusive lines and optional `--expected-hash`. |
| `strata inspect <file>` | `contract` | Deep component inspection (props, emits, slots, state). Options: `--symbol <name>`, `--audit-events`, `--outline`, `--infer-props`, `--resolve-globals` |

Recommended workflow: `strata find --map src --json`, choose a file, run `strata inspect <file> --view map --json`, then pass a returned region's `ref` to `--view source`. The map locates code; it does not certify implementation correctness. Unsupported analysis and truncated results remain explicit.
| `strata tree [entry]` | `component-tree` | Inspect component hierarchy tree or upward blast radius. Options: `--route <path>`, `--depth <n>`, `--direction <downward\|upward>`, `--alias <map>`, `--scope-filter <scope>` |
| `strata trace <state-id>` | `impact` | Trace reactive state blast radius and consumers. Options: `--depth <n>`, `--direction <consumers\|dependencies\|both>`, `--role <all\|mutators\|readers>` |
| `strata audit [dir]` | `routes`, `apis`, `dead-state`, `archetype` | Audit frontend architecture. Options: `--target <target>`, `--threshold <n>`, `--exemplar <file>`, `--ignore <globs>`, `--include-pages`, `--scope-path <dir>`, `--exclude-dirs <dirs>` |
| `strata patch <file>` | `patch-plan` | Generate prescriptive refactoring patch plans across callers. Options: `--refactor <type>`, `--old <name>`, `--new <name>` |
| `strata stats [dir]` | `telemetry` | Display MCP tool latency percentiles (p50/p95), error rates, and items found |

### Direct CLI Shortcuts

- `strata routes [path]` — Extract route topology manifest (shortcut for `audit --target routes`)
- `strata apis [path]` — Extract outbound HTTP API calls and caller mapping (shortcut for `audit --target api-contracts`)
- `strata dead-state [path]` — Detect unused reactive state composables and stores (shortcut for `audit --target dead-state`)
- `strata archetype <file>` — Audit page archetype and structural drift vs exemplar (shortcut for `audit --target archetype-drift`)
- `strata usage <component>` — Search component adoption (shortcut for `find --component <name>`)
- `strata rule <rule-yaml>` — Execute raw ast-grep YAML rule (shortcut for `find --rule <yaml>`)

### Global Options

- `-p, --path <path>`: Target directory or file path (default: `.`)
- `--json`: Output raw JSON instead of human-readable formatted text
- `-v, --version`: Display current Strata version
- `-h, --help`: Display contextual command options and usage

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
