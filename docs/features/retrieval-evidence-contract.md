# Query Envelope, Verification Evidence & Response Budgets

## V2 `QueryEnvelope<TData>` Contract

Every V2 service (`mapWorkspace`, `inspectFile`, `queryGraph`, `readSlice`, `searchCode`) returns a uniform `QueryEnvelope<TData>` defined in `src/engine/v2/contracts.ts` and rendered by `src/tools/v2/formatter.ts`:

| Field | Type | Contract |
|---|---|---|
| `scope` | `string` | Canonical workspace root, package scope, or target file path inspected by the query. |
| `verification` | `'graph' \| 'semantic' \| 'syntax-fallback'` | Evidence tier achieved: `'graph'` (SQLite Schema v3 index), `'semantic'` (SQLite index + TypeScript `LanguageService` / `TypeChecker`), or `'syntax-fallback'` (AST fallback when semantic expansion fails). |
| `data` | `TData` | Tool-specific payload (`packages`, `routes`, `files`, `health`, `outline`, `contract`, `boundaries`, `items`, `summaryByPackage`, `tree`, `content`, or `matches`). |
| `pagination` | `PaginationMeta?` | Present on pageable collections: `{ total, limit, offset, hasMore, nextCursor }`, where `nextCursor` uses deterministic offset encoding (`o_<offset>`). |
| `omissions` | `OmissionRecord[]` | Static analysis boundaries that require manual inspection (such as `DYNAMIC_SPREAD` for `v-bind="obj"` or `{...props}`), including `code`, `filePath`, `line`, `column`, `reason`, and a hash-bound `sourceRef`. |
| `diagnostics` | `DiagnosticRecord[]` | Actionable warnings and boundaries (such as `CONTRACT_TYPES_UNRESOLVED`, `SEMANTIC_PROP_EXPANSION_FAILED`, `DYNAMIC_HTTP_METHOD`, `COMPONENT_TREE_TRUNCATED`, `SLICE_TRUNCATED`, or `STATE_FLOW_NO_MATCHES`). |

## Hash-Verified `sourceRef` Handles

All 5 tools exchange deterministic source references (`src/engine/v2/source-ref.ts`) formatted as:

```text
ref:<hash8>:<startOffset>-<endOffset>@<filePath>
```

- `<hash8>` is the first 8 hex characters of the file's SHA-256 content hash (`shortHashFromFull(content_hash)` from SQLite or `shortHash(raw)` from disk).
- When passed to `read_slice(source_ref)`, Strata recomputes the on-disk file's SHA-256 prefix and rejects modified files with `[STALE_SOURCE]` so agents never read shifted byte spans.

## Response Formats, Pagination & `max_bytes` Budgets

| Parameter | Default | Contract |
|---|---|---|
| `format` | `'text'` | Compact, token-efficient text by default (`'text' \| 'json'`). In MCP stdio transport (`src/mcp.ts`), `'text'` responses omit `structuredContent` to avoid duplicating payloads in the client context window; `'json'` responses retain `structuredContent`. |
| `limit` & `cursor` | `100` (`map_workspace`) / `30` (`query_graph`, `search_code`) | `paginateItems` slices the ordered collection before reading file snippets or building heavy DTOs, returning `nextCursor: "o_<nextOffset>"` when `hasMore` is `true`. |
| `max_bytes` | `16384` (min `512`) | Enforced by `enforceResponseLimit` (`src/engine/context-budget.ts`) on the serialized MCP response. If a response exceeds `max_bytes`, the dispatcher returns a structured `[BUDGET_RESPONSE_TOO_LARGE]` error with `retryMaxBytes` and narrowing guidance (`limit`, `sections`, `package`, or `max_lines`). |

## Verification

- `tests/core/v2-query-services.test.ts`: `QueryEnvelope` structure, `verification` tiers, `omissions`, and `diagnostics` across all 5 services.
- `tests/core/scalability-optimizations.test.ts`: paginate-before-I/O, cursor pagination (`o_<offset>`), and `summaryByPackage` invariants.
- `tests/core/source-reference.test.ts`: hash-bound `source_ref` validation and stale-source detection.
- `tests/core/retrieval-evidence.test.ts`: evidence metadata, freshness, and omission reporting.
- `tests/integration/mcp-v2-protocol.test.ts`: serialized `max_bytes` size limits and MCP transport framing.

Owners: [contracts](../../src/engine/v2/contracts.ts),
[source-ref](../../src/engine/v2/source-ref.ts),
[catalog](../../src/tools/v2/catalog.ts),
[handlers](../../src/tools/v2/handlers.ts),
[formatter](../../src/tools/v2/formatter.ts),
[response budget](../../src/engine/context-budget.ts),
[MCP dispatcher](../../src/mcp.ts), [CLI dispatch](../../src/cli.ts).
