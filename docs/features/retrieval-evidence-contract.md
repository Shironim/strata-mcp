# Retrieval evidence, response budgets and continuation

**Status:** Implementation contract
**Last updated:** 2026-11-14

## Evidence ownership

`src/types.ts` defines `RetrievalEvidence`; `source-file.ts`,
`retrieval-evidence.ts` and `index-retrieval-evidence.ts` capture its evidence.
The response wrapper adds conservative fallback metadata to uninstrumented branches.
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
| `queryId`, `retrievalId`, `engineRevision` | Query/retrieval identity and package/compiler policy identity; not a signed attestation or a hash of every engine source file. |

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
| `max_bytes` | Safe integer at least 512; MCP defaults to 16384 bytes. Applies to the serialized tool result, including text and structured metadata, excluding JSON-RPC framing. |
| `response_detail` | `full` or `summary`; summaries are projections with explicit omitted-detail diagnostics. Exact source requires full detail. |
| `include_structured` | In text MCP transport, retain full structured content when requested; otherwise the dispatcher replaces it with an omission notice. |
| `continuation_token` | Repeat the same analysis with the returned token to select the next page. Summary requests do not accept continuation. |

A 512-byte minimum does not promise every metadata block or item fits. Budget
errors distinguish metadata, item and final response size failures. Source text
is not cut into arbitrary fragments to satisfy a budget.

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
it; source/dependency/configuration rebuilds or route-manifest changes advance it.
Therefore an unchanged preflight does not invalidate the next tree/state page.

## Verification

- `tests/core/continuation-identity.test.ts`: selection/source mutation and query identity.
- `tests/core/analysis-consistency.test.ts`: unchanged tree continuation and changed-input rejection.
- `tests/mcp/serialized-budget.test.ts`: serialized size limits and exact-source preservation.
- `tests/mcp/summary-response.test.ts`: summary boundaries and full-detail recovery.
