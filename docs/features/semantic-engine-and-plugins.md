# TypeScript Semantic Engine & `FrameworkPlugin` Architecture

Strata MCP achieves IDE-grade semantic precision across Vue, Nuxt, React, Next.js, Svelte, and Astro in-process—without external CLI subprocesses or loading an entire multi-project repository into a single TypeScript program.

## `FrameworkPlugin` Contract (`src/plugins/`)

Each frontend framework (`vue`, `react`, `svelte`, `astro`) is an isolated plugin implementing:
- `projectToVirtualTs(filePath, content, sourceHash)` → `VirtualDocument` with `O(log N)` bidirectional offset mapping (`toVirtualOffset()` ↔ `toOriginalSpan()`).
- `extractTier1Facts(doc, rawContent)` → fast syntax-level component usages, slots, render boundaries, and `DYNAMIC_SPREAD` omissions. Identity plugins (e.g. `reactPlugin` for `.ts`/`.tsx`/`.js`/`.jsx`) attach their pre-parsed `sourceFile` (`setParentNodes: false`) so Tier-1 symbol extraction reuses the AST without double-parsing.

## `SemanticProjectPool` (`src/engine/v2/semantic/`)

- **Scoped per `tsconfig.json`**: Each monorepo package gets its own lazily-created `ts.LanguageService` via `StrataLanguageServiceHost`.
- **Virtual TSX Interception**: `.vue`, `.svelte`, and `.astro` files are projected into valid Virtual TSX (`<path>.__strata__.tsx`) so `ts.TypeChecker` and `findReferences()` operate uniformly across SFCs and `.ts`/`.tsx`. `VirtualFileRegistry` lazily caches `lineStarts` per file (`getLineStarts()`), making `mapVirtualLocation` `O(log L)` per reference instead of re-scanning file bytes on every hit.
- **Monorepo & Auto-Import Resolution**: Resolves workspace `package.json#exports` directly to source files (even before `dist/` is built) and ingests `.nuxt/imports.d.ts` & `.nuxt/components.d.ts`.
- **Bounded Memory (LRU)**: Enforces `maxActiveProjects` (default `3`), memory soft-cap (`512 MB`), and idle TTL, calling `languageService.dispose()` on eviction.
- **Pure-JS Fallback**: Packages without a `tsconfig.json` receive a synthetic `allowJs: true` compiler configuration.
