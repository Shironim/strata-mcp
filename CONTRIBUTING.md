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

- `src/engine/`: Core search engine, AST-grep wrapper, SFC splitter, offset remapper, template matcher, contract extractor (`contract.ts`), component hierarchy tree engine (`tree.ts`), file-based route topology scanner (`routes.ts`), persistent SQLite codebase graph (`database.ts`), and unused component auditor (`audit.ts`).
- `src/adapters/`: Document Adapter pattern (`VueAdapter`, `AstroAdapter`, `ScriptAdapter`, and `AdapterFactory`).
- `src/mcp.ts`: Model Context Protocol server implementation exposing 12 tools.
- `src/cli.ts`: Standalone CLI companion (`strata`, `strata-mcp`).
- `src/types.ts`: Centralized TypeScript data models and interfaces.
- `tests/`: Automated unit, integration, and fixtures test suites.

## Pull Request Guidelines

- Ensure `bun test` passes with zero failures (`bun test`).
- Ensure TypeScript typecheck is clean (`bun run typecheck` / `tsc --noEmit`).
- Preserve 100% line number accuracy across `.vue` and `.astro` multi-language files.
- Enforce Strict Token Economy: Never dump raw bytes or verbose AST dumps into tool outputs.
