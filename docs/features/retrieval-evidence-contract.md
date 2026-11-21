# Retrieval Evidence, Response Budgets, and Continuation

## Evidence Ownership

`src/types.ts` defines `RetrievalEvidence`; `src/engine/source-file.ts` and
`src/engine/retrieval-evidence.ts` capture its evidence.
The response layer adds conservative fallback metadata when full provenance is unavailable.
A hash identifies captured inputs; it does not establish semantic correctness or
complete workspace coverage.

The principal fields are:

| Field | Contract |
|---|---|
| `basis` | `source` or `derived`; indexed analysis is represented through `index`, not a third basis value. |
| `freshness` | `current`, `stale`, or `unavailable`, relative to `freshnessBoundary`. |
| `completeness` | `complete` or `partial`, relative to the selected policy and scope. |
| `source` | Optional primary source snapshot: file, SHA-256, UTF-8 encoding, UTF-16 offset unit and line count. |
| `index` | Optional generation, configuration fingerprint, cache version, manifest hash and observed consistency. |
| `dependencies` | Separately reports whether dependency freshness was verified. |
| `omissions`, `limitations` | Preserve unsupported syntax, failed reads and selection boundaries. |
| `queryId`, `retrievalId`, `engineRevision` | Query and retrieval identities. Engine revision combines the package version with the first 16 hex characters of the analysis fingerprint. See [Storage & Monorepo Sync](storage-and-monorepo-sync.md). |

Source references bind `[startOffset, endOffset)` to a source SHA-256.
Inclusive `source_range` selections can also supply `expected_hash`.
Changed source invalidates the reference; map or retrieve it again.

Indexed observations are checked before and after analysis. A stable observation
is not an atomic filesystem snapshot, so indexed results retain partial coverage
and explicit disk/dependency freshness limitations. Filesystem audits likewise
report partial evidence rather than claiming one atomic input snapshot.

## Response pipeline

Requests are normalized at the boundary. Analysis produces structured data and a
primary representation. Evidence attachment precedes summary projection, decision
metadata, pagination and rendering. JSON text mirrors are rendered from structured
data; legacy arrays and exact source preserve their primary representation.
The MCP dispatcher also enforces the final serialized response limit.

| Parameter | Contract |
|---|---|
| `format` | Text by default; JSON for structured analysis (`'text' \| 'json'`). |
| `max_bytes` | Safe integer at least 512; MCP defaults to 16384 bytes. Applies to the serialized tool result, including text and structured metadata, excluding JSON-RPC framing. |
| `response_detail` | `full` or `summary`; summaries are projections with explicit omitted-detail diagnostics. Exact source requires full detail. |
| `include_structured` | False by default in text MCP transport; true retains `structuredContent`. Otherwise the dispatcher omits `structuredContent` when `content` text is present. JSON requests retain `structuredContent`. Direct handler calls do not perform this dispatcher stripping. |
| `continuation_token` | Repeat the same analysis with the returned token to select the next page. Summary requests do not accept continuation. |

A 512-byte minimum does not promise every metadata block or item fits. Budget
errors distinguish metadata, item and final response size failures. Source text
is not cut into arbitrary fragments to satisfy a budget.

### Effective detail default and transport boundaries

| Aspect | Behavior |
|---|---|
| **`response_detail` default** | Both JSON Schema and runtime default to `"full"` (still subject to `max_bytes` pagination). Summary mode is opt-in: specify `response_detail: "summary"` explicitly when you only need counts/previews and diagnostics. |
| **`summary` vs `full`** | Summary projection returns `resultSummary`, preserved `safetyDetails`, `isTruncated`, and available evidence/diagnostics. `full` can still be paginated when exceeding `max_bytes`. `summary` combined with `continuation_token` or an exact source selector is rejected. |
| **`decision` metadata** | Supplies `status`, `emptyOutcome`, `selection`, capability assessment, and suggested `next` actions. It describes the observed result—a zero count alone does not establish runtime absence. |
| **MCP vs CLI output** | These rules describe MCP/wrapped-tool responses. CLI commands calling engine functions directly can print raw analysis JSON or text without the MCP evidence/decision envelope or transport omission behavior. |

## Continuation identity

When one pageable collection exceeds the budget, the result includes
`continuationToken`, `offset`, `nextOffset`, `totalAvailable` and `hasMore`.
`retrieval.budget` contains `maxBytes`, `estimatedBytes`, `isTruncated` and
`consistency: selection-bound`. Supply `continuation_token` on the next request.
Multiple independent collections may require a narrower target or larger budget.

Tokens are unsigned base64url JSON. Validation checks the tool, query identity,
engine revision, applicable source hash/index generation/configuration fingerprint,
and the hash of the ordered selection. This detects input or selection changes;
it does not authenticate the caller or prove a complete dependency snapshot.

`sync_generation` identifies published index revisions. Unchanged sync preserves
it. Published source, dependency, configuration, or analysis-fingerprint changes
and route-manifest changes can advance it.
Therefore an unchanged preflight does not invalidate the next tree/state page.

## Verification

- `tests/core/retrieval-evidence.test.ts`: evidence metadata, freshness, and omission reporting.
- `tests/core/source-reference.test.ts`: hash-bound `source_ref` validation and stale-source detection.
- `tests/integration/mcp-v2-protocol.test.ts`: serialized size limits, continuation, and MCP transport framing.

Owners: [catalog](../../src/tools/v2/catalog.ts),
[handlers](../../src/tools/v2/handlers.ts),
[formatter](../../src/tools/v2/formatter.ts),
[response budget](../../src/engine/context-budget.ts),
[MCP dispatcher](../../src/mcp.ts), [CLI dispatch](../../src/cli.ts).
