# Lifecycle Hooks and Analysis Execution

## Generated Post-Write Hook

`src/cli/templates.ts` owns `STRATA_POST_WRITE_HOOK`.
`src/cli/mcp-configs.ts` generates harness-specific configuration; the init command
installs the selected artifacts. The script extracts a changed file path from the
harness payload, environment or arguments, checks frontend extensions and invokes
`strata sync` in the resolved workspace through an available executable.

Hook invocation depends on the installed client, its configuration and the edit
mechanism. Generated artifacts and tests do not prove that every client invokes
them for every edit. Sync failures are deliberately non-blocking in the generated
post-write script. The index reflects completed syncs; hook generation alone does
not establish continuous freshness.

Septum pre-write boundary guards are a separate installation and policy owner.
Strata does not establish their presence or enforcement by generating its own
post-write hook. Validate those integration boundaries in the actual client.

## Analysis Preflight

Indexed workspace, file, and graph operations refresh `.strata/graph.db` before querying it.
Failed refresh is an analysis error rather than a successful empty result.
Direct `read_slice` calls inspect files on disk with hash verification and do not require index initialization.

Internal prepared callers may use `skipSync` only when they own the preflight.
A successful sync does not establish atomic freshness of every later filesystem
read; retrieval evidence describes this boundary separately.

## MCP execution lifecycle

The host launches the [MCP entrypoint](../../src/mcp.ts) as a local process. With
no arguments and non-interactive stdin, it receives JSON-RPC on stdin and sends
replies on stdout. With CLI arguments it delegates to CLI dispatch. Interactive
execution without arguments prints CLI help.

The MCP SDK handles `initialize` and `notifications/initialized`. The server
advertises tools, resources, prompts, and usage instructions. `tools/list`
returns the catalog and input schemas. The client chooses when to send
`tools/call`. Resource and prompt requests have their own handlers outside the
tool queue.

For `tools/call`, Strata normalizes arguments and chooses a workspace hint
from explicit `root`, the remembered root for the supplied `session_id`, or
the last known project root, in that order. Handlers resolve their target paths
using that context. Successful calls can update the remembered root. The
session ID is a tool argument and the root map lives in that server instance.
SQLite data persists separately across process restarts.

- **Concurrency and limits (`AnalysisSupervisor` in `src/analysis-supervisor.ts`).**
  - **Fast Read-Only Lane (`maxConcurrentFast: 4`)**: Jobs classified by `isFastReadOnlyJob(name, args)`—`map_workspace`, `read_slice`, `search_code`, `inspect_file` with `resolve_types: false`, and `query_graph` with `query` in `call_hierarchy | component_tree | state_flow`—run up to **4 jobs concurrently** when no exclusive job is active, preventing head-of-line blocking behind cold TypeScript `TypeChecker` initialization.
  - **Exclusive Semantic Serialization (`C = 1`)**: Jobs that invoke `SemanticProjectPool` (`inspect_file` with default `resolve_types: true`, and `query_graph` for `definition`, `references`, or `impact`) wait for active fast jobs to drain and execute exclusively (`activeExclusive = true`) so TypeScript `LanguageService` memory stays bounded within the 512 MB soft cap.
  - **Per-Request Root & Signal Isolation**: Each active job executes inside `runWithRequestProjectRoot(effectiveRoot, ...)` (`AsyncLocalStorage` in `src/engine/path-resolver.ts`) so concurrent jobs across different workspaces never overwrite each other's `lastKnownProjectRoot`. Up to 16 requests can wait in the queue (`queued: 16`); serialized requests larger than 2 MiB (`requestBytes`) are rejected with `REQUEST_TOO_LARGE`, and each executing job has a 120-second timeout (`timeoutMs: 120000`).
- **Cancellation & shutdown:** Each running job owns its own `AbortController` in `activeControllers`. Timeout or client cancellation rejects the caller response and aborts that job's signal while keeping its execution slot reserved until handler cleanup settles. Queued cancellations remove the request from the queue; `close()` aborts all active controllers, rejects queued jobs, waits for all active fast and exclusive slots to drain, and disposes `defaultSyncCoordinator`, `defaultSemanticPool`, and `defaultWarmDbPool`.
- **Cooperative abort scope:** Source reads, sync checkpoints, and in-process scans cooperate with `AbortSignal`.
- **Progress notifications (`_meta.progressToken`).** When a client supplies a progress token, the dispatcher forwards stage updates emitted through `reportAnalysisProgress`.
- **Warm pools & virtual file cache:** `WarmDatabasePool` keeps SQLite connections open in WAL mode across requests; `SemanticProjectPool` caches up to 3 active `ts.LanguageService` projects (LRU) with `VirtualFileRegistry` caching projected SFC virtual TSX documents and `lineStarts` per file content hash.

On completion the dispatcher applies the [final response budget](retrieval-evidence-contract.md) and records [tool telemetry](tool-call-logging.md). Shutdown starts on `SIGINT`, `SIGTERM`, or stdio stream closure and waits for active analysis cleanup before exiting.

## Verification

- `tests/core/tier1-v3-storage-sync.test.ts`: incremental sync and SQLite Schema v3 preflight invariants.
- `tests/core/v2-query-services.test.ts`: v2 workspace, inspection, graph, slice, and search service behavior.
- `tests/core/scalability-optimizations.test.ts`: `AnalysisSupervisor` fast read-only concurrency, single-SQL `impact` pagination, `propUsage` SQL pre-filtering, and 1-hop graph HTTP boundary tracing.
- `tests/cli/cli-v2.test.ts`: CLI v2 command dispatch and `init` artifact generation.
- `tests/integration/mcp-v2-protocol.test.ts`: stdio JSON-RPC handshake, `_meta.progressToken` notifications, and text-mode `structuredContent` omission.
