# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-02

### Added
- **Persistent SQLite Codebase Graph Cache**: High-performance local graph cache (`.vue-ast/graph.db`) powered by native `bun:sqlite` with WAL mode. Replaces repeated per-request disk scanning with smart `mtime` delta synchronization (< 10ms warm sync).
- **Recursive CTE Blast Radius & Anti-Join Audits**: Enables instant SQL-level transitive closure queries for upward component blast radiuses, layout chains, and zero-overhead dead component detection.
- **State Impact Analysis (`query_state_impact`)**: Traces all components, layout wrappers, and pages consuming a specific state store (Pinia/Zustand/Redux), Context, or custom composable.
- **File-Based Route Topology Scanner (`scan_routes`)**: Automated discovery of routing manifests across Next.js (App Router & Pages Router), Nuxt 3, Astro, and Inertia.js. Resolves URL routes, dynamic parameters (`[id]`, `[...slug]`, `[[...optional]]`), layout nesting chains, and HTTP API handlers.
- **Auto-Import Component Resolution**: Native component discovery for Nuxt 3 and modern Vite (`unplugin-vue-components`) setups, resolving template tags without explicit script setup imports.
- **Upward Blast Radius Component Tree**: Bidirectional tree traversal (`direction: "upward"`) tracking component impact from leaf elements up to parent consumers, layouts, and top-level pages.
- **Isomorphic Render Boundary Detection**: Automatic classification of React Server Components (RSC), `'use client'`, `'use server'`, Astro hydrated islands (`client:*`), and Nuxt `.client.vue` / `.server.vue`.
- **Out-of-Band State & Store Dependency Extraction**: Extracts global state dependencies (Pinia, Zustand, Redux) and context/composable injections (`useContext`, `inject`, custom `use*` composables) directly into component contracts.
- **Unified Parameter Aliases**: Seamless support for `path` and `target_path` aliases across all MCP tools, with informative error guarding for missing arguments.
- **CLI Commands Expansion**: Added `vue-ast routes`, `vue-ast impact <state-id>`, `vue-ast sync`, and `--direction <downward|upward>` option for `vue-ast tree`.

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
