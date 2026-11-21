# Lifecycle hooks and analysis execution

## Generated post-write hook

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

## Analysis preflight

Indexed tree/state operations and patch planning refresh initialized indices before
querying them. Failed refresh is an analysis error, rather than a successful empty
result. Source-only inspection/search and filesystem audits do not require index
initialization. Library upward traversal and patch planning retain source fallback
on uninitialized workspaces without creating `.strata`.

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

- **Concurrency and limits (`AnalysisSupervisor`).** One tool handler runs at a time in the server process, with up to four waiting requests by default. The 2 MiB limit applies to the serialized job (name, normalized arguments, and root hint). The 120-second timer starts when execution begins. Calls beyond queue capacity receive `SERVER_BUSY`. The defaults can be overridden when constructing a supervisor.
- **Cancellation & shutdown:** Timeout or cancellation rejects the client response and aborts the request signal while retaining the execution slot until handler and database cleanup settle. Queued cancellations remove the request; shutdown rejects queued work, aborts active work, and waits for cleanup. Parallel audit/pool work settles all started siblings before returning a failure.
- **Cooperative abort scope:** Source reads, sync checkpoints, and `ast-grep` search subprocesses cooperate with cancellation. Cancellation cannot preempt synchronous JavaScript or enforce a hard process memory limit. No separate analysis worker is launched.
- **Progress notifications (`_meta.progressToken`).** If a client supplies a progress token, the dispatcher forwards updates emitted by the operation through `reportAnalysisProgress`. Current emitters include workspace sync, component tree traversal, frontend audits, patch planning, and selected search branches.
- **Per-request syntax cache:** Retains at most 32 ASTs and at most 2 MiB of source text (UTF-16 accounting), keyed by filename, script kind, and exact source hash, and is discarded after the request. AST memory overhead is additional (not a heap/RSS limit), and source/dependency freshness checks still read disk.

On completion the supervisor closes registered database connections. The
dispatcher applies the [final response budget](retrieval-evidence-contract.md)
and records [tool telemetry](tool-call-logging.md). Shutdown can start on
`SIGINT`, `SIGTERM`, or stream or connection closure. The shutdown path waits
for active analysis cleanup before closing the server and exiting.

## Verification

- `tests/memory/supervisor.test.ts`: timeout/abort serialization, queued rejection and shutdown cleanup.
- `tests/core/analysis-execution.test.ts`: real subprocess termination, temporary-input cleanup, bounded search/pool work and syntax-cache isolation.
- `tests/core/analysis-consistency.test.ts`: failed preflight and cancellation publication boundaries.
- `tests/cli/init-harness.test.ts`, `tests/cli/init-audit-fixes.test.ts`: generated harness artifacts; active client execution is outside their scope.
- `tests/integration/mcp-server-protocol.test.ts`: stdio JSON-RPC handshake, `_meta.progressToken` notifications, and text-mode `structuredContent` omission.
