# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-09-05

### Added

- **Smart Path Resolver (`src/engine/path-resolver.ts`)**:
  - Transparent cross-framework path alias resolution (`@/*`, `~/*`, `$lib/*`) mapped from `tsconfig.json`, `jsconfig.json`, or customizable alias maps.
  - Implicit extension matching (`.vue`, `.tsx`, `.jsx`, `.ts`, `.js`, `/index.*`) and robust cross-platform path normalization (Windows backslashes vs POSIX forward slashes).
- **Dynamic Imports & Lazy-Loading Engine (`src/engine/dynamic-imports.ts`)**:
  - Structural AST scanning for dynamic code-splitting and lazy imports: `import(...)`, Vue `defineAsyncComponent(...)`, React `React.lazy(...)`, and Next.js `next/dynamic(...)`.
  - Integration with route and component graph traversal to prevent missing lazy-loaded boundaries.
- **Frontend Contract Mastery & Data Fetching Boundaries (`src/engine/contract.ts`)**:
  - Egress/ingress boundary contracts surfaced in `inspect_component`: captures Laravel Inertia (`useForm`, `router.post/get/put/delete`, `form.post`), TanStack Query (`useQuery`, `useMutation`), SWR, Axios, and native Fetch API.
  - Automatic extraction of target endpoints (string literals, Ziggy `route('...')` helpers, template literals) and payload keys for cross-validation against backend API routes.
  - Form dictionary & file upload contracts: extracts `<form>` field tags, required input validations, and marks `isMultipart: true` upon detecting `<input type="file">` or `FormData`.
  - Deep prop shape inference (`infer_props: true`) for nested data access (`props.user.profile.avatar`) and global helper detection (`resolve_globals: true`).
- **First-Class Props Drilling Diagnostics (`src/engine/tree.ts`)**:
  - Traversal analysis in `get_component_tree` surfacing `drillingAlerts`: flags props forwarded across >2 component hierarchy levels without local usage or template mutation.
- **Context Dependency Graph & Dangling Context Detection (`src/engine/tree.ts`)**:
  - Hierarchical tracking of Vue `provide` / `inject` and React `createContext` / `useContext` across component trees.
  - Surfaces `contextGraph.danglingConsumers` to flag consumer components rendered without an ancestor provider in the active route tree.
- **First-Class Reactivity Smells Diagnoser (`src/engine/reactivity.ts`)**:
  - Integrated into `inspect_component`: detects reactive prop destructuring (`const { prop } = props`), direct prop mutation (`props.prop = val`), dangling watch effects, and redundant reactive state allocations.
- **Structural Template Similarity Engine (`src/engine/template-similarity.ts`)**:
  - DOM AST topology hashing and similarity scoring (configurable threshold, default 0.8) to identify structural copy-paste slop and component consolidation opportunities.
- **Design System & Accessibility (a11y) Auditing (`src/engine/style-audit.ts`)**:
  - Surfaced in `audit_frontend`: audits arbitrary/hardcoded hex colors (`#hex`, `rgb`) vs design token scales, detects form inputs lacking accessible labels, and flags non-semantic clickable elements (`<div @click>` without keyboard accessibility or ARIA roles).
- **Bundle & Astro Island Health Audit (`src/engine/bundle-audit.ts`)**:
  - Audits Astro/Nuxt/Next island hydration strategies (`client:load` vs `client:visible` vs `client:idle`).
  - Identifies heavy eager imports (e.g., `echarts`, `chart.js`, `lodash`, `moment`) running inside eagerly hydrated client islands.

### Changed

- **Unified 5 Core MCP Tools Architecture**:
  - Streamlined MCP server interface down to 5 high-density, versatile tools: `find_code`, `inspect_component`, `get_component_tree`, `trace_state`, and `audit_frontend`.
  - Rich responses equipped with first-class diagnostic fields (`boundaryContracts`, `formContracts`, `drillingAlerts`, `reactivitySmells`, `designAudit`, `bundleAudit`, `similarTemplates`).
- **Token Economy & Output Formatting (`src/engine/formatter.ts`)**:
  - Enhanced text formatters and structured JSON outputs designed for zero-raw-byte token optimization in LLM context windows.

## [0.6.0] - 2026-09-03

### Changed

- **Trust-free ast-grep distribution**: replaced the `@ast-grep/cli` top-level wrapper
  (which had a `postinstall` script requiring `bun pm trust @ast-grep/cli`)
  with official upstream prebuilt platform packages
  `@ast-grep/cli-linux-x64-gnu`,
  `@ast-grep/cli-win32-x64-msvc`,
  `@ast-grep/cli-darwin-arm64`, and
  `@ast-grep/cli-darwin-x64` (ast-grep 0.45.3), wired up as
  `optionalDependencies`. Installs now work out of the box on Linux (x64),
  Windows (x64), and macOS (Apple Silicon & Intel) with no trust step; other platforms fall back to a system
  `ast-grep` on `$PATH` or the `AST_GREP_BIN` environment variable with a
  warning-only message instead of a startup failure. Binary resolution order:
  `AST_GREP_BIN` → scoped platform package → legacy `@ast-grep/cli` install →
  `$PATH`.
- **ast-grep 0.38 → 0.45 compatibility**: treat `ast-grep run` exit code 1 with
  empty stdout/stderr as "no matches" (0.45 changed the exit code), and accept
  `--debug-query` CST output on stderr regardless of exit code.

### Added

- **Resolver unit tests** (`tests/astgrep/resolver.test.ts`): platform mapping,
  `AST_GREP_BIN` override, and graceful-degradation messaging.

## [0.5.0] - 2026-09-02

### Added

- **New Tool — `find_unused_state`**: Batch dead-code auditor for composables, stores, hooks, and utility functions. Scans `composables/`, `hooks/`, `stores/`, and `utils/` directories using the SQLite graph engine (`state_deps`) to detect functions and stores with zero external consumers. Exposed as both an MCP tool (`find_unused_state(target_path, output_format)`) and a CLI command (`strata unused-state [target-dir]`).
- **Engine Observability Metadata (`_meta`)**: All audit results now include execution transparency metadata. Text output surfaces a badge (e.g. `[Engine: sqlite-graph-cache | 6ms]`); JSON output includes a structured `_meta: { engine, durationMs, cached }` payload. Applies consistently across all tools.
- **`scan_routes` Summary Mode (`view: "summary"`)**: Projects with more than 40 routes (or any project using `view: "summary"`) now receive aggregated output grouped by domain/module (e.g. `/admin/*: 42 routes`, `/auth/*: 6 routes`), significantly reducing token consumption for large codebases.
- **`scan_routes` Prefix Filter**: New `prefix` parameter enables focused inspection of specific sub-modules (e.g. `prefix: "/services"`, `prefix: "/auth"`), returning only routes matching the given path prefix.
- **CLI Flags Expansion**: New flags added to the `strata` binary: `--prefix <prefix>` and `--view <mode>` for `strata routes`, and `--include-pages` for `strata unused`.

### Fixed

- **Case-Insensitive Glob Matching in `find_unused_components`**: `matchesGlob()` now normalizes paths to lowercase before matching, resolving false negatives on directories with capital letters (e.g. `resources/js/Pages/**` in Inertia/Nuxt projects).
- **Structured Output Partition in `find_unused_components`**: Results are now explicitly partitioned into two distinct categories — `orphanComponents` (reusable UI components in `Components/**` with zero usages) and `unreferencedPages` (page-level files in `Pages/**` with no template callers). The `exclude_pages: true` option (enabled by default) eliminates false positives from router-managed page files.

## [0.4.0] - 2026-09-02

### Added
- **Project Rebranding (`strata-mcp`)**: Rebranded package to `strata-mcp` with CLI binary `strata`, reflecting full multi-framework intelligence across Vue, React, Next.js, Nuxt 3, Astro, and Inertia.js.
- **Route-to-Component Tree Resolver (`resolve_page_tree` & `get_component_tree(route_path)`)**: 1-step direct resolution from URL paths (e.g. `/catalog`, `/products/[id]`) directly to page entrypoint files, nested layout chains, and downward component hierarchy trees.
- **RSC / SSR & Hydration Boundary Violation Auditor**: Automatic detection and actionable error hints for client-only hook leaks (`useState`, `useEffect`, etc.) or DOM event handlers in Next.js Server Components without `'use client'`, plus unhydrated interactive island warnings in Astro.
- **CVA & Design System Variant Schema Slicing**: Structured extraction of Class Variance Authority (`cva()`) and TypeScript prop union variant configurations (`variants` and `defaultVariants`) on `extract_component_contract`.
- **Data-Fetching & Server Action Lineage Slicing**: Extraction of Next.js Server Actions (`'use server'`), TanStack Query keys (`['cart', userId]`), API endpoints (`$fetch`, `fetch`, `axios`), and Inertia form mutations (`POST /auth/login`).
- **Monorepo & Domain Boundary Scoping (`scope_filter`)**: Scoped component tree traversal with `--scope-filter` / `scope_filter`, preventing context flooding across multi-package monorepos and annotating boundary crossings with `[external-domain/package]`.
- **Persistent SQLite Codebase Graph Cache**: High-performance local graph cache (`.strata/graph.db`) powered by native `bun:sqlite` with WAL mode. Replaces repeated per-request disk scanning with smart `mtime` delta synchronization (< 10ms warm sync).
- **Recursive CTE Blast Radius & Anti-Join Audits**: Enables instant SQL-level transitive closure queries for upward component blast radiuses, layout chains, and zero-overhead dead component detection.
- **State Impact Analysis (`query_state_impact`)**: Traces all components, layout wrappers, and pages consuming a specific state store (Pinia/Zustand/Redux), Context, or custom composable.
- **File-Based Route Topology Scanner (`scan_routes`)**: Automated discovery of routing manifests across Next.js (App Router & Pages Router), Nuxt 3, Astro, and Inertia.js. Resolves URL routes, dynamic parameters (`[id]`, `[...slug]`, `[[...optional]]`), layout nesting chains, and HTTP API handlers.
- **Auto-Import Component Resolution**: Native component discovery for Nuxt 3 and modern Vite (`unplugin-vue-components`) setups, resolving template tags without explicit script setup imports.
- **Upward Blast Radius Component Tree**: Bidirectional tree traversal (`direction: "upward"`) tracking component impact from leaf elements up to parent consumers, layouts, and top-level pages.
- **Unified Parameter Aliases**: Seamless support for `path` and `target_path` aliases across all 11 MCP tools, with informative error guarding for missing arguments.
- **CLI Commands Expansion**: Added `strata routes`, `strata impact <state-id>`, `strata sync`, `--route <path>`, `--scope-filter <scope>`, and `--direction <downward|upward>` option for `strata tree`.

## [0.3.0] - 2026-09-01

### Added
- **Fast-Path Candidate Pruning**: Keyword pre-filtering on `findCode`, `findCodeByRule`, and `findComponentUsage`, reducing search execution times by up to 97% by skipping subprocess spawns for non-matching files.
- **Component Interface Contract Extraction (`extract_component_contract`)**: Extracts public contracts (`props`, `emits`, `slots`, `exposed`) for Vue SFC, React TSX, and Astro with over 94% token savings.
- **Downward Component Tree Engine (`get_component_tree`)**: Resolves component dependency hierarchies and call trees up to configurable depth, supporting static imports, aliases, barrel re-exports, and cross-framework Astro islands.
- **Dead & Unreferenced Component Audit (`find_unused_components`)**: Monorepo audit tool identifying orphan components with zero project usages, supporting custom glob ignore patterns.

### Fixed
- **Multi-Casing Resolution**: Unified kebab-case and PascalCase candidate matching for imports, barrel files, and JSX elements.
- **Barrel Re-Export Chasing**: Comprehensive re-export resolution through `export { default as Component }` and `export { Component }`.
- **ast-grep Binary Path Resolution**: Hardened binary resolver traversing ancestor directories and platform vendor binary locations.
- **Template Tag Matching**: Automatic HTML template AST matching for patterns like `<ProductCard $$$/>` with accurate line remapping.

## [0.2.0] - 2026-09-01

### Added
- **Native Astro (`.astro`) Support**: Document parser separating frontmatter TypeScript (`---`) and JSX-like templates with exact offset preservation.
- **Astro Islands Hydration Directives**: Detection and surface of `client:load`, `client:visible`, `client:idle`, `client:media`, and `client:only`.
- **Dynamic & Lazy Imports**: Detection of `defineAsyncComponent` (Vue/Nuxt), `React.lazy` (React), and `dynamic()` (Next.js).
- **Barrel Re-export Detection**: Full audit support for `export { default as X }` and `export { X }` in barrel files.
- **Import Alias & Namespace Linking**: Resolves local aliases (`import { X as Y }` -> `<Y />`) and namespace components (`<UI.X />`) back to the original component.

## [0.1.0] - 2026-09-01

### Added
- **SFC Splitter**: Precise block separation for `<template>`, `<script>`, and `<script setup>` with 100% offset fidelity.
- **ast-grep Runner**: Native JS/TS search engine wrapper with stdin streaming and automatic Windows/Linux binary resolution.
- **Template Matcher**: Vue AST template traversal supporting PascalCase, kebab-case, and dynamic `<component :is="...">`.
- **Offset Remapper**: Accurate conversion of local block coordinates to original `.vue` line and column numbers.
- **Core Search Engine**: Multi-file recursive scanner supporting `.vue`, `.ts`, `.tsx`, `.js`, and `.jsx`.
- **MCP Server**: Full implementation with 5 tools (`find_code`, `find_code_by_rule`, `find_component_usage`, `dump_syntax_tree`, `test_match_code_rule`).
- **CLI Companion**: Standalone `vue-ast` binary for terminal usage with text and JSON outputs.
- **Test Suite**: 25 automated unit and integration tests across 7 test suites (104 assertions).
