# Contributing to strata-mcp

Thank you for your interest in contributing to `strata-mcp`!

## Getting Started

1. Clone the repository.
2. Install dependencies with Bun:
   ```bash
   bun install
   ```
3. Run the test suite:
   ```bash
   bun test
   ```

## Development Architecture

- `src/engine/`: Core AST intelligence engines:
  - **Search & Slicing**: AST-grep wrapper (`astgrep.ts`), search coordinator (`search.ts`), symbol slicer (`slicer.ts`), SFC splitter (`splitter.ts`), offset remapper (`remapper.ts`), and template matcher (`template.ts`).
  - **Component & Contract Intelligence**: Public interface contract extractor (`contract.ts`), layout & Tailwind token extractor (`layout-extractor.ts`), reactivity smell & event handler auditor (`reactivity.ts`), and prescriptive refactoring planner (`patch-plan.ts`).
  - **Graph & Hierarchy (`src/engine/graph/`)**: Downward/upward component hierarchy tree (`tree.ts`, `downward-traversal.ts`, `upward-traversal.ts`), props drilling detector (`props-drilling.ts`), context/provide-inject analyzer (`context-analyzer.ts`), and barrel/alias import resolution (`path-helpers.ts`, `resolution.ts`).
  - **Topology, State & API Boundaries**: File-based route scanner (`routes.ts`), outbound API contract & transport analyzer (`api-contract.ts`, `transport-analyzer.ts`), and persistent SQLite state/composable graph (`database.ts`, `watcher.ts`).
  - **Architectural Health Audits**: Dead component detector (`audit.ts`), structural template similarity (`template-similarity.ts`), design token & a11y auditor (`style-audit.ts`), bundle & hydration health (`bundle-audit.ts`), page archetype drift detector (`archetype.ts`), and dynamic import resolver (`dynamic-imports.ts`).
  - **Infrastructure**: Smart workspace path resolver & input normalizers (`path-resolver.ts`), bounded concurrency pool (`pool.ts`), and latency/error telemetry (`telemetry.ts`).
- `src/adapters/`: Document Adapter pattern (`VueAdapter`, `AstroAdapter`, `ScriptAdapter`, and `AdapterFactory`).
- `src/tools/`: Unified **8 Core MCP Tools** (`find_code`, `inspect_component`, `get_component_tree`, `trace_state`, `audit_frontend`, `generate_patch_plan`, `get_routes`, `get_api_contracts`).
- `src/mcp.ts`: Model Context Protocol stdio server, fuzzy tool/argument coercion (`coerceToolArguments`), and request dispatcher with telemetry recording.
- `src/cli.ts` & `src/cli/`: Standalone CLI companion (`strata`, `strata-mcp`) and workspace initializer (`strata init` for `.agents/` rules, skills, and hooks).
- `src/types.ts`: Centralized TypeScript data models and interfaces.
- `tests/`: Automated unit, integration, CLI-MCP parity, and multi-framework fixture test suites.

## Pull Request Guidelines

- Ensure the test suite passes with zero failures (`bun test`).
- Ensure TypeScript typecheck and bundle build succeed (`bun run typecheck` and `bun run build`).
- **CLI & MCP Parity**: Any new capability, filter (`scope_path`, `exclude_dirs`), or input coercion added to an MCP tool in `src/tools/` must maintain behavioral parity with `src/cli.ts` and shared helpers in `src/engine/path-resolver.ts`.
- Preserve 100% line and column number accuracy across `.vue`, `.astro`, `.tsx`, and `.jsx` files.
- Enforce Strict Token Economy: Format default text outputs concisely for LLM context efficiency; never dump raw file contents or unbounded AST trees.
