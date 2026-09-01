# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-01

### Added
- **Phase 1: Fast-Path Candidate Pruning (Engine B Optimization)**:
  - Keyword pre-filtering on `findCode`, `findCodeByRule`, and `findComponentUsage`.
  - Drops search execution times by 97% (from ~1,150ms to < 30ms, < 2ms for non-existent symbols) by skipping child process spawns.
- **Phase 2: Component Interface Contract Extraction (`extract_component_contract`)**:
  - Extracts public component contracts (`props`, `emits`, `slots`, `exposed`) for Vue SFC, React TSX, and Astro.
  - Achieves > 94% context window token reduction (< 80 tokens/component vs ~1,500 raw tokens).
  - Companion CLI command: `vue-ast contract <path> [--json]`.
- **Phase 3: Downward Component Tree & SQLite Graph (`get_component_tree`)**:
  - Downward component hierarchy tree and call graph visualizer up to configurable `max_depth`.
  - Embedded in-memory graph index powered by C-level `bun:sqlite` with recursive CTE queries (< 15ms).
  - Traverses static imports, local aliases, barrel re-exports (`export { default as X }`), and cross-framework Astro islands.
  - Companion CLI command: `vue-ast tree <entry-path> [--depth <n>] [--json]`.
- **Phase 4: Dead & Unreferenced Component Audit (`find_unused_components`)**:
  - Two-pass in-memory audit scanning monorepos for dead components with 0 usages across project files.
  - Customizable glob ignore patterns (`ignore_patterns`) for router pages, views, and test stories.
  - Companion CLI command: `vue-ast unused [dir] [--ignore <patterns>] [--json]`.

### Fixed
- **GAP-01 (Multi-Casing Resolution)**: Unified kebab-case and PascalCase candidate matching for imports, barrel files, and JSX elements.
- **GAP-02 (Barrel Re-Export Chasing)**: Comprehensive re-export resolution through `export { default as Component }` and `export { Component }`.
- **GAP-03 (`ast-grep` Binary Path Resolution)**: Hardened resolver traversing ancestor directories and platform vendor binary locations.
- **GAP-04 (Template Tag Matching)**: Automatic HTML template AST matching for patterns like `<ProductCard $$$/>` with accurate line remapping.

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
