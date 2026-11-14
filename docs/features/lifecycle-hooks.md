# Lifecycle hooks and analysis execution

**Status:** Implementation contract
**Last updated:** 2026-11-14

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

`AnalysisSupervisor` runs one analysis at a time in the server process and admits
up to four waiting requests by default. Requests are limited to 2 MiB and the
default response deadline is 120 seconds. These limits are configurable through
`SupervisorOptions.limits`.

Timeout/cancellation rejects the client response and aborts the request signal.
The execution slot is retained until the handler and database cleanup settle.
Queued cancellation removes that request. Shutdown rejects queued work, aborts
active work and waits for its cleanup. Parallel audit/pool work also settles all
started siblings before returning a failure.

Source reads, sync checkpoints and ast-grep search/CST subprocesses cooperate with
cancellation. It cannot preempt synchronous JavaScript or guarantee a hard process
memory limit. No separate analysis worker is launched; `workerPath` is retained as
a deprecated compatibility option with no effect.

The per-request syntax cache retains at most 32 ASTs and at most 2 MiB of source
text (UTF-16 accounting), keyed by filename, script kind and exact source hash.
AST overhead is additional; this is not a heap/RSS limit. Source and dependency
freshness checks still read disk. The cache is discarded with the request.

## Verification

- `tests/memory/supervisor.test.ts`: timeout/abort serialization, queued rejection and shutdown cleanup.
- `tests/core/analysis-execution.test.ts`: real subprocess termination, temporary-input cleanup, bounded search/pool work and syntax-cache isolation.
- `tests/core/analysis-consistency.test.ts`: failed preflight and cancellation publication boundaries.
- `tests/cli/init-harness.test.ts`, `tests/cli/init-audit-fixes.test.ts`: generated harness artifacts; active client execution is outside their scope.
