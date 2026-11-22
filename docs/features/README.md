# Strata MCP — Feature Documentation

Strata MCP is a local static and semantic code analysis server and CLI for Vue, Nuxt, React, Next.js, Svelte, and Astro codebases. It pairs a persistent SQLite symbol graph (`.strata/graph.db`) with a scoped TypeScript Language Service across single-repo apps, fullstack projects, monoliths, and monorepos.

---

## MCP Tools

| Tool | Purpose | Backing Engine | Documentation |
| :--- | :--- | :--- | :--- |
| **`map_workspace`** | Map projects, frameworks, routes, files, and unused candidates | SQLite Index | [map_workspace.md](./map_workspace.md) |
| **`inspect_file`** | File outline, TypeChecker-resolved contract, and HTTP boundaries (body-free) | SQLite Index + TypeScript Language Service | [inspect_file.md](./inspect_file.md) |
| **`query_graph`** | Definition, references, call/component/state flow, and refactor impact | SQLite Index + TypeScript Language Service | [query_graph.md](./query_graph.md) |
| **`read_slice`** | Selective, hash-verified source reading | Direct disk read + hash verification | [read_slice.md](./read_slice.md) |
| **`search_code`** | Workspace symbol search (FTS5), component/prop usage, scoped text | SQLite FTS5 + in-process scanner | [search_code.md](./search_code.md) |

---

## Architecture & Platform Docs

- **[storage-and-monorepo-sync.md](./storage-and-monorepo-sync.md)** — SQLite Schema v3 (`packages`, `files`, `symbols`, `symbol_edges`, `routes`, `symbols_fts`), scoped cross-file graph linker, warm connection pool, and incremental sync.
- **[semantic-engine-and-plugins.md](./semantic-engine-and-plugins.md)** — `FrameworkPlugin` contract, Virtual TSX projection + bidirectional offset mapping, and `SemanticProjectPool` LRU lifecycle.
- **[resources-and-prompts.md](./resources-and-prompts.md)** — Interactive Strata Explorer MCP App (`ui://strata/explorer.html`), MCP Resources (`strata://project/overview`, `strata://components/index`, `strata://apps`, `strata://component/{name}`), and workflow playbooks (`open-apps`, `onboard-workspace`, `trace-bug`, `safe-refactor`).
- **[retrieval-evidence-contract.md](./retrieval-evidence-contract.md)** — `QueryEnvelope` contract (`verification`, `pagination`, `omissions`, `diagnostics`), hash-verified `sourceRef` handles, and `max_bytes` response budgets.
- **[tool-call-logging.md](./tool-call-logging.md)** — Structured JSONL telemetry (`.strata/strata.log`) and `strata stats`.
- **[lifecycle-hooks.md](./lifecycle-hooks.md)** — Client post-write hooks and `AnalysisSupervisor` fast-lane concurrency.
