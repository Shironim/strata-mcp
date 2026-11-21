# Strata Tool Call Logging

Local logging contract for the six MCP tools. Implementation owner: `src/engine/telemetry.ts`;
integration: `src/mcp.ts`; regressions: `tests/telemetry.test.ts`.

## Logged Data Evaluation

| Data | Decision and Purpose |
| --- | --- |
| UTC Timestamp, tool, status, duration | Recorded for every invocation reaching the dispatcher, including handler errors, analysis exceptions, and unknown tools. Duration measures internal execution prior to logging, not network/client transport latency. |
| Action/view/target/direction/refactor_type | The dispatcher uses recognized schema modes and defaults, with branch inference for `find_code` and `inspect_component`. Some calls omit `action`. |
| Trace/session ID | Stored IDs are capped at 64 characters. The dispatcher generates a 12-character trace ID when missing. Session IDs come from the caller. |
| Input | Up to 16 normalized argument keys. Allowlisted scalar fields such as `mode` and `symbol` retain their values, with strings capped at 96 characters. Allowlisted path fields (`path`, `file_path`, `target_path`) retain up to 120 characters. Absolute paths are reduced to a workspace-relative path or basename. Other string values, including `code` and `pattern`, are recorded by UTF-8 byte count. Other values are recorded by type. |
| `metrics.bytes_out` | Total UTF-8 bytes across all final text blocks. Excludes protocol envelope and structured content. |
| `metrics.lines_out` | Total line count across all text blocks combined. Empty text yields zero; trailing newlines produce a blank line. |
| `metrics.estimated_tokens` | `Math.round(bytes_out / 4)`. Rough text estimate only, not exact tokenizer/model usage or structured content volume. |
| `metrics.response_bytes` | Total UTF-8 bytes of serialized MCP result JSON, including structured content; excludes JSON-RPC framing. Computed after `enforceResponseLimit`. |
| `bloat_alert` | `true` once `response_bytes` exceeds 16 KiB; may trigger even with brief text if structured content is large. |
| `metrics.items_found` | Preserves tool-specific item extraction where available. May be absent; item count does not imply total nodes, full coverage, or relevance. |
| Output digest | Defaults to `preview_disabled`, or `empty_output` if there is no non-whitespace text. `STRATA_LOG_PREVIEW=1` enables a sanitized head/omission/tail snippet of at most 300 characters. |
| Error | Error code up to 64 characters and message up to 384 characters (128 characters during fallback budget logging). Thrown errors can include up to six filtered stack frames, capped at 160 characters each. Frames are removed if the serialized event exceeds 4095 bytes. Error messages and frame text can retain project details. |
| Project data in logs | Allowlisted inputs, error messages, filtered stack frames, and opt-in output previews may contain project details. |

## Sink and Lifecycle

- One JSON Lines event per tool call written to `<workspace>/.strata/strata.log`; only when `.strata/` already exists. Root resolution prefers analysis result, explicit root, session root hint, with cwd as final fallback.
- No additional logging metadata injected into MCP responses or stdout. Stderr emits single warnings prioritizing error, bloat, then slow execution (`duration_ms >= 250`). All metrics remain available in the event.
- New log files are created with `0600` permissions (subject to OS capabilities). Existing files retain their permissions.
- Rotation executes before an append would push file size past 2 MiB; a single backup file `.strata/strata.log.1` replaces any previous backup. If rotation fails, the append is skipped to prevent unbounded file growth.
- Logger uses synchronous I/O; no shutdown flush is required. Writes do not include an fsync durability guarantee or coordinate rotation across processes on the same root.
- Serialization errors, synchronous stderr writes, and filesystem issues never fail a tool response. If stderr fails synchronously, the file sink is still attempted. Logging is best-effort: events may drop during I/O failures or process termination.
- The `strata init` scaffolding writes `.strata/` to `.gitignore` and `*` to `.strata/.gitignore`; no scaffold modifications required.
- Direct CLI/library function calls and SDK-rejected requests prior to dispatcher entry are not captured. The `strata stats` summary inspects the active log without merging `.1`.

## Monitoring

```sh
tail -f .strata/strata.log
jq 'select(.bloat_alert == true) | {tool, action, metrics}' .strata/strata.log
jq 'select(.duration_ms >= 250) | {tool, action, duration_ms}' .strata/strata.log
jq 'select(.status == "error") | {tool, error}' .strata/strata.log
strata stats . --json
```

Set `STRATA_LOG_PREVIEW=1` in the MCP server process environment and restart the server to activate previews.
New builds require restarting active client/server sessions running legacy artifacts.

## Verification

Regressions verify JSONL/UTF-8 compliance, complete response metrics, exact 16 KiB bloat threshold,
output digests and opt-in toggles, rotation replacing old backups, sink failure isolation, and dispatcher
routing across all six tools including handler errors, unknown tools, and supervisor rejections.
Compatibility tests enforce input masking and ensure `.strata/` is never auto-created on unindexed workspaces.
Local test, build, and stdio results do not prove active MCP clients have loaded this version.
