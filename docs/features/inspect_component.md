# inspect_component — contracts, source and symbols

Inspect one component/module, map its source regions, retrieve exact source or
inspect symbols. Adapters include Vue, JSX/TSX, Svelte, Astro and scripts.
No initialized index is required. Contract extraction and caller discovery are
static analyses with reported limitations, separate from exact source retrieval.

## Parameters

| Parameter | Effective behavior |
|---|---|
| `path` | Required target file. Aliases include `file_path`, `filePath`, `target_path`, `component`, `component_path`. A root alone does not select a component. |
| `project_root` | Explicit root for path resolution/discovery; aliases `root`, `workspace_root`. Explicit roots do not require a project marker. |
| `view` | `map` selects source regions; `source` retrieves a supplied `source_ref`. Omit for other operations or the default contract. |
| `source_ref` | `{sha256,startOffset,endOffset}`; requires `view: "source"`. Offsets are end-exclusive UTF-16 indices. |
| `source_range` | Inclusive `{start_line,end_line}`; positive integers. |
| `expected_hash` | Optional SHA-256 check for `source_range`; alias `expectedHash`. Rejected without a range. |
| `max_regions` | Source-map top-level region cap, default 200, maximum 500; alias `maxRegions`. |
| `sfc_sections` | Retrieve exact Vue SFC block content/boundaries as a separate operation. |
| `symbol` | Symbol to slice with discovered callers/test references; aliases include `symbol_name`, `name`. |
| `outline` | Symbol outline; aliases include `include_outline`, `outline_symbols`. |
| `audit_events` | Vue event-handler audit; alias `auditEvents`. |
| `impact` | Contract-only prop impact: `none` (default), `summary`, `full`. Supported static consumer coverage (Vue, React/JSX, Svelte, Astro) is reported by the analyzer. |

`format`, `include_structured`, `response_detail`, `max_bytes` and
`continuation_token` follow the [shared contract](retrieval-evidence-contract.md).
The default detail level is `full`; pass `response_detail: "summary"` explicitly
for counts/previews only.

## Operation selection

Choose at most one of `view`, `symbol`, `outline`, `source_range`, `sfc_sections`
and `audit_events`. Non-`none` impact conflicts with all those selectors.
`source_ref` requires `view: "source"`; it cannot accompany an ordinary contract
request. With no selector, the operation extracts a component/module contract.

Exact-source requests (source view, ranges, SFC sections) reject
`response_detail: "summary"`. A stale reference or expected hash is an error;
obtain a new map/snapshot rather than reusing old offsets. Source reads have an
8 MiB size limit. Missing-file candidates are suggestions, not automatic
substitutions of a different target.

## Contract and symbol boundaries

- **Contract fields:** Can include props, emits, slots/details, models, exposed members, variants, state/data dependencies, render boundaries, layout/form information, outbound boundary contracts, unresolved types, captured dependencies, and `projectContext`. Fields vary by adapter and syntax; ownership/manifest evidence and heuristic boundaries do not prove runtime behavior.
- **Svelte slots:** Public slot evidence includes static legacy slot nodes and typed `Snippet` props. Local snippet declarations appear in the source map.
- **React prop-type resolution bounds:** Covers bounded local/imported prop-type resolution and supported component wrappers. Its type module graph stops at 64 modules or depth > 24, symbol lookup is capped at 4096 visits, and local type expansion has a depth bound of 32. Bare package type specifiers are not resolved by this module graph—review unresolved types and dependencies.
- **Outbound boundary extraction:** Recognizes supported literal/route/action syntax and can enrich contracts from one hop of supported local composables. Fields include `boundaryType`, `method`, `targetEndpoint`, `endpointSource`, optional `payloadKeys`, `loc`, `source`, `viaComposable`, and `backendTargetHint` (candidate symbols, not verified backend targets).
  Supported `fetch`, `$fetch`, `useFetch`, and Axios calls share an AST extractor with the API audit. Boundaries keep the source endpoint form and report call coordinates. Both outputs preserve `HEAD` and `OPTIONS`. Dynamic methods are reported as `UNKNOWN`. A TanStack mutation with an unresolved callback endpoint retains its action symbol when available. For `mutationFn: () => save()`, full text marks the endpoint unresolved. The compact `apiCalls` entry includes `method: "UNKNOWN"`, `endpoint: "save"`, `endpointSource: "action-symbol"`, and the mutation location. For a direct identifier callback or a simple arrow calling an identifier in the inspected script, an optional `callbackDefinition` records the declared symbol, file, and one-based line and column. Supported targets are local functions, const function expressions, and direct named function exports from relative script modules in the workspace. Import aliases and lexical shadowing are respected. Re-exports, dynamic dispatch, and the endpoint behind the callback remain unresolved.
- **Symbol & outline operations:** Report supported declarations and callee/caller links, distinguishing confirmed static calls from passive importer candidates (neither establishes exhaustive runtime reachability). The text symbol formatter previews bodies above its 50-line threshold and suggests `source_range` for retrieving original text.

## Requests and observed output excerpt

```json
{"path":"src/Card.vue","view":"map","format":"json","response_detail":"full"}
```

```json
{"path":"src/Card.vue","source_range":{"start_line":1,"end_line":20},"format":"json","response_detail":"full"}
```

```json
{"path":"src/Card.vue","impact":"full","project_root":".","format":"json","response_detail":"full"}
```

For a fixture containing `fetch('/api/cards')`, the local MCP probe returned this
boundary-contract excerpt; other contract/evidence fields are omitted here:

```json
{
  "boundaryContracts": [
    {
      "boundaryType": "native-fetch",
      "method": "GET",
      "targetEndpoint": "/api/cards",
      "endpointSource": "literal",
      "loc": {"line": 5},
      "source": "inline"
    }
  ]
}
```

This is not a complete response schema. A summary instead uses `resultSummary`,
`safetyDetails`, `isTruncated`, evidence and decision metadata. Full-detail
responses remain subject to the byte budget. Default text MCP transport strips
full structured content unless `include_structured: true`.

## Owners and verification

- [Handler](../../src/tools/inspect-component.ts), [selectors](../../src/tools/request.ts),
  [source operations](../../src/tools/inspect-source.ts), [symbols](../../src/tools/inspect-symbols.ts).
- [Contract](../../src/engine/contract.ts), [type modules](../../src/engine/parsers/prop-type-modules.ts),
  [source snapshots](../../src/engine/source-file.ts), [types](../../src/types.ts).
- [AST parser tests](../../tests/core/ast-native-parser.test.ts),
  [summary tests](../../tests/mcp/summary-response.test.ts),
  [budget tests](../../tests/mcp/serialized-budget.test.ts).
