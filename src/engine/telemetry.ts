import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const telemetryStageStorage = new AsyncLocalStorage<{ stage?: string }>();

export function runWithTelemetryStage<T>(fn: () => T): T {
  return telemetryStageStorage.run({}, fn);
}

export function setTelemetryStage(stage: string): void {
  const store = telemetryStageStorage.getStore();
  if (store) store.stage = stage;
}

export function getTelemetryStage(): string | undefined {
  return telemetryStageStorage.getStore()?.stage;
}

const SAFE_INPUT_SCALAR_KEYS = new Set([
  'action', 'mode', 'target', 'direction', 'refactor_type', 'format', 'output_format',
  'depth', 'view', 'outline', 'sfc_sections', 'audit_events', 'language', 'scope',
  'response_detail', 'symbol',
]);

const SAFE_INPUT_PATH_KEYS = new Set(['path', 'file_path', 'target_path']);

function sanitizePathValue(raw: string, workspaceRoot: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (isAbsolute(trimmed)) {
    const rel = relative(workspaceRoot, trimmed);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return rel.slice(0, 120);
    }
    return basename(trimmed).slice(0, 120);
  }
  return trimmed.slice(0, 120);
}

function sanitizeStackFrames(stack: string | undefined, workspaceRoot: string): string[] | undefined {
  if (!stack || typeof stack !== 'string') return undefined;
  const frames = stack
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
    .slice(0, 6)
    .map(line => {
      const normalized = line.replace(/\(([^)]+)\)/g, (_m, loc: string) => {
        const match = loc.match(/^(.*):(\d+:\d+)$/);
        if (!match) return `(${basename(loc)})`;
        const rel = isAbsolute(match[1]) ? sanitizePathValue(match[1], workspaceRoot) : match[1];
        return `(${rel}:${match[2]})`;
      });
      return normalized.slice(0, 160);
    });
  return frames.length > 0 ? frames : undefined;
}

export interface StrataToolCallEvent {
  timestamp?: string;
  trace_id?: string;
  session_id?: string;
  event: 'tool_call_completed' | 'tool_call_failed';
  tool: string;
  action?: string;
  stage?: string;
  duration_ms: number;
  cache_hit?: boolean;
  empty_result?: boolean;
  fallback_used?: string;
  incomplete_evidence?: boolean;
  omissions_count?: number;
  input: Record<string, any>;
  metrics?: {
    bytes_out?: number;
    lines_out?: number;
    items_found?: number;
    estimated_tokens?: number;
    response_bytes?: number;
    source_bytes?: number;
  };
  bloat_alert?: boolean;
  output_digest?: { summary?: string; sample_preview?: string };
  status: 'success' | 'error';
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
  stack_frames?: string[];
}

export interface ToolMetricSummary {
  calls: number;
  errors: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalItemsFound: number;
  totalBytesOut: number;
  emptyResults?: number;
}

export interface ObservabilitySummary {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  errorRatePercent: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  slowCallsCount: number;
  totalBytesOut: number;
  totalItemsFound: number;
  emptyResultsCount: number;
  emptyResultRatePercent: number;
  fallbackCallsCount: number;
  incompleteEvidenceCount: number;
  bloatAlertsCount: number;
  cacheHitsCount: number;
  totalSourceBytes: number;
  contextSavingsPercent: number | null;
  toolBreakdown: Record<string, ToolMetricSummary>;
  actionBreakdown: Record<string, { calls: number; errors: number; emptyResults: number }>;
  recentErrors: Array<{
    timestamp: string;
    tool: string;
    message: string;
    code?: string;
    stage?: string;
    stack_frames?: string[];
  }>;
}

export class StrataTelemetry {
  public static readonly MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024;
  public static readonly SLOW_EXECUTION_THRESHOLD_MS = 250;
  public static readonly BLOAT_BYTE_THRESHOLD = 16 * 1024;

  public static createOutputDigest(rawText: string, maxChars = 300): NonNullable<StrataToolCallEvent['output_digest']> {
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (!text) return { summary: 'empty_output' };
    const limit = Number.isFinite(maxChars) ? Math.max(0, Math.min(300, Math.floor(maxChars))) : 300;
    if (text.length <= limit) return { sample_preview: text };
    // Include the omission marker in the limit, including for very small budgets.
    let remaining = Math.max(0, limit - 40);
    let marker = '';
    for (let i = 0; i < 4; i++) {
      marker = ` ... [${text.length - remaining} chars omitted] ... `;
      remaining = Math.max(0, limit - marker.length);
    }
    if (marker.length >= limit) return { sample_preview: marker.slice(0, limit) };
    const head = Math.ceil(remaining / 2);
    const tail = remaining - head;
    return { sample_preview: text.slice(0, head) + marker + (tail ? text.slice(-tail) : '') };
  }

  /** Measure the final public result; never attach telemetry to the MCP response. */
  public static recordToolResponse(
    event: StrataToolCallEvent,
    response: { content?: Array<{ text?: unknown }> },
    workspaceRoot: string = process.cwd()
  ): void {
    try {
      const texts = (response.content ?? []).flatMap(item => typeof item.text === 'string' ? [item.text] : []);
      const bytes = texts.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
      const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      const isEmptyResult = event.status === 'success' && event.metrics?.items_found === 0 ? true : undefined;
      this.recordToolCall({
        ...event,
        stage: event.stage ?? getTelemetryStage(),
        ...(isEmptyResult ? { empty_result: true } : {}),
        metrics: {
          ...event.metrics,
          bytes_out: bytes,
          lines_out: texts.reduce((sum, value) => sum + (value ? value.split('\n').length : 0), 0),
          estimated_tokens: Math.round(bytes / 4),
          response_bytes: responseBytes,
        },
        bloat_alert: responseBytes >= this.BLOAT_BYTE_THRESHOLD,
        output_digest: texts.every(text => !text.trim()) ? { summary: 'empty_output' }
          : process.env.STRATA_LOG_PREVIEW === '1' ? this.createOutputDigest(texts.join('\n'))
          : { summary: 'preview_disabled' },
      }, workspaceRoot);
    } catch {
      // Measurement must not change the tool's result either.
    }
  }

  /**
   * Resolves the log file path inside the active workspace's .strata directory.
   */
  public static getLogPath(workspaceRoot: string = process.cwd()): string {
    return join(workspaceRoot, '.strata', 'strata.log');
  }

  /**
   * Records a tool call event to both stderr (dual-sink) and .strata/strata.log.
   */
  public static recordToolCall(
    event: StrataToolCallEvent,
    workspaceRoot: string = process.cwd()
  ): void {
    try {
      const input: Record<string, any> = {};
      for (const key of Object.keys(event.input).slice(0, 16)) {
        const value = event.input[key];
        const safeKey = key.slice(0, 32);
        if (SAFE_INPUT_PATH_KEYS.has(key) && typeof value === 'string') {
          input[safeKey] = sanitizePathValue(value, workspaceRoot);
        } else if (SAFE_INPUT_SCALAR_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
          input[safeKey] = typeof value === 'string' ? value.slice(0, 96) : value;
        } else {
          input[safeKey] = typeof value === 'string' ? { bytes: Buffer.byteLength(value) } : { type: typeof value };
        }
      }
      const stackFrames = event.status === 'error' ? sanitizeStackFrames(event.error?.stack, workspaceRoot) : undefined;
      const payload: StrataToolCallEvent = {
        timestamp: (event.timestamp || new Date().toISOString()).slice(0, 64),
        event: event.event, tool: event.tool.slice(0, 64), duration_ms: event.duration_ms,
        trace_id: event.trace_id?.slice(0, 64), session_id: event.session_id?.slice(0, 64),
        status: event.status, input, metrics: event.metrics,
        action: event.action?.slice(0, 64),
        ...(event.stage ? { stage: event.stage.slice(0, 64) } : {}),
        ...(event.cache_hit !== undefined ? { cache_hit: event.cache_hit } : {}),
        ...(event.empty_result ? { empty_result: true } : {}),
        ...(event.fallback_used ? { fallback_used: event.fallback_used.slice(0, 64) } : {}),
        ...(event.incomplete_evidence !== undefined ? { incomplete_evidence: event.incomplete_evidence } : {}),
        ...(event.omissions_count !== undefined ? { omissions_count: event.omissions_count } : {}),
        bloat_alert: event.bloat_alert,
        output_digest: event.output_digest,
        error: event.error ? { code: event.error.code?.slice(0, 64), message: event.error.message.slice(0, 384) } : undefined,
        ...(stackFrames ? { stack_frames: stackFrames } : {}),
      };

      let jsonLine = JSON.stringify(payload);
      if (Buffer.byteLength(jsonLine) > 4095) {
        delete payload.stack_frames;
        jsonLine = JSON.stringify(payload);
      }
      if (Buffer.byteLength(jsonLine) > 4095) {
        payload.input = {}; payload.output_digest = { summary: 'log_entry_budget' };
        if (payload.error) payload.error.message = payload.error.message.slice(0, 128);
        jsonLine = JSON.stringify(payload);
      }

      // A broken stderr sink must not prevent persistence.
      try {
        if (payload.status === 'error') {
          process.stderr.write(`[strata-telemetry ERROR] ${jsonLine}\n`);
        } else if (payload.bloat_alert) {
          process.stderr.write(`[strata-telemetry BLOAT_WARN] ${jsonLine}\n`);
        } else if (payload.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS) {
          process.stderr.write(`[strata-telemetry SLOW_WARN] ${jsonLine}\n`);
        }
      } catch {}

      // Sink 2: Append-only persistent file recorder in .strata/strata.log (only if .strata already exists)
      try {
        const logPath = this.getLogPath(workspaceRoot);
        const logDir = dirname(logPath);

        // Do NOT create .strata directory if it does not already exist
        if (!existsSync(logDir)) {
          return;
        }

        // Check for rotation if file exceeds 2MB
        if (existsSync(logPath)) {
          try {
            const stats = statSync(logPath);
            if (stats.size + Buffer.byteLength(jsonLine) + 1 > this.MAX_LOG_SIZE_BYTES) {
              const rotatedPath = `${logPath}.1`;
              renameSync(logPath, rotatedPath);
            }
          } catch { return; }
        }

        appendFileSync(logPath, `${jsonLine}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Telemetry file writes must never crash the main application process
      }
    } catch {
      // Serialization failures are isolated from tool execution.
    }
  }

  private static emptySummary(): ObservabilitySummary {
    return {
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      errorRatePercent: 0,
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      slowCallsCount: 0,
      totalBytesOut: 0,
      totalItemsFound: 0,
      emptyResultsCount: 0,
      emptyResultRatePercent: 0,
      fallbackCallsCount: 0,
      incompleteEvidenceCount: 0,
      bloatAlertsCount: 0,
      cacheHitsCount: 0,
      totalSourceBytes: 0,
      contextSavingsPercent: null,
      toolBreakdown: {},
      actionBreakdown: {},
      recentErrors: [],
    };
  }

  /**
   * Aggregates telemetry records from .strata/strata.log into an ObservabilitySummary.
   */
  public static getSummary(
    workspaceRoot: string = process.cwd(),
    limit = 500,
    toolFilter?: string
  ): ObservabilitySummary {
    const logPath = this.getLogPath(workspaceRoot);
    if (!existsSync(logPath)) {
      return this.emptySummary();
    }

    let lines: string[] = [];
    try {
      const content = readFileSync(logPath, 'utf8');
      lines = content.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      return this.emptySummary();
    }

    const events: StrataToolCallEvent[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const ev = JSON.parse(line) as StrataToolCallEvent;
        if (!toolFilter || ev.tool === toolFilter) {
          events.push(ev);
        }
      } catch {
        // ignore malformed lines
      }
    }

    if (events.length === 0) {
      return this.emptySummary();
    }

    let successCount = 0;
    let errorCount = 0;
    let slowCallsCount = 0;
    let totalBytesOut = 0;
    let totalItemsFound = 0;
    let emptyResultsCount = 0;
    let fallbackCallsCount = 0;
    let incompleteEvidenceCount = 0;
    let bloatAlertsCount = 0;
    let cacheHitsCount = 0;
    let totalSourceBytes = 0;
    let sourceOutputBytes = 0;
    const durations: number[] = [];
    const recentErrors: ObservabilitySummary['recentErrors'] = [];
    const actionBreakdown: ObservabilitySummary['actionBreakdown'] = {};

    const toolStatsMap: Record<
      string,
      {
        calls: number;
        errors: number;
        durations: number[];
        itemsFound: number;
        bytesOut: number;
        emptyResults: number;
      }
    > = {};

    for (const ev of events) {
      const tool = ev.tool || 'unknown';
      if (!toolStatsMap[tool]) {
        toolStatsMap[tool] = {
          calls: 0,
          errors: 0,
          durations: [],
          itemsFound: 0,
          bytesOut: 0,
          emptyResults: 0,
        };
      }

      toolStatsMap[tool].calls++;
      durations.push(ev.duration_ms || 0);
      toolStatsMap[tool].durations.push(ev.duration_ms || 0);

      const bytes = ev.metrics?.bytes_out || 0;
      totalBytesOut += bytes;
      toolStatsMap[tool].bytesOut += bytes;

      if (typeof ev.metrics?.source_bytes === 'number' && ev.metrics.source_bytes > 0) {
        totalSourceBytes += ev.metrics.source_bytes;
        sourceOutputBytes += bytes;
      }

      const items = ev.metrics?.items_found || 0;
      totalItemsFound += items;
      toolStatsMap[tool].itemsFound += items;

      if (ev.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS) slowCallsCount++;
      if (ev.bloat_alert) bloatAlertsCount++;
      if (ev.cache_hit) cacheHitsCount++;
      if (ev.fallback_used) fallbackCallsCount++;
      if (ev.incomplete_evidence) incompleteEvidenceCount++;

      const isEmpty = Boolean(ev.empty_result) || (ev.status === 'success' && ev.metrics?.items_found === 0);
      if (isEmpty) {
        emptyResultsCount++;
        toolStatsMap[tool].emptyResults++;
      }

      if (ev.action) {
        const actionKey = `${tool}:${ev.action}`;
        if (!actionBreakdown[actionKey]) {
          actionBreakdown[actionKey] = { calls: 0, errors: 0, emptyResults: 0 };
        }
        actionBreakdown[actionKey].calls++;
        if (ev.status === 'error') actionBreakdown[actionKey].errors++;
        if (isEmpty) actionBreakdown[actionKey].emptyResults++;
      }

      if (ev.status === 'error') {
        errorCount++;
        toolStatsMap[tool].errors++;
        recentErrors.push({
          timestamp: ev.timestamp || '',
          tool,
          message: ev.error?.message || 'Unknown error',
          code: ev.error?.code,
          ...(ev.stage ? { stage: ev.stage } : {}),
          ...(ev.stack_frames ? { stack_frames: ev.stack_frames } : {}),
        });
      } else {
        successCount++;
      }
    }

    const calcPercentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    };

    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

    const toolBreakdown: Record<string, ToolMetricSummary> = {};
    for (const [tool, st] of Object.entries(toolStatsMap)) {
      toolBreakdown[tool] = {
        calls: st.calls,
        errors: st.errors,
        avgDurationMs:
          st.durations.length > 0
            ? Math.round(st.durations.reduce((a, b) => a + b, 0) / st.durations.length)
            : 0,
        p50DurationMs: calcPercentile(st.durations, 50),
        p95DurationMs: calcPercentile(st.durations, 95),
        totalItemsFound: st.itemsFound,
        totalBytesOut: st.bytesOut,
        emptyResults: st.emptyResults,
      };
    }

    const contextSavingsPercent = totalSourceBytes > 0
      ? Math.round(((totalSourceBytes - sourceOutputBytes) / totalSourceBytes) * 1000) / 10
      : null;

    return {
      totalCalls: events.length,
      successCount,
      errorCount,
      errorRatePercent: Math.round((errorCount / events.length) * 1000) / 10,
      avgDurationMs,
      p50DurationMs: calcPercentile(durations, 50),
      p95DurationMs: calcPercentile(durations, 95),
      slowCallsCount,
      totalBytesOut,
      totalItemsFound,
      emptyResultsCount,
      emptyResultRatePercent: Math.round((emptyResultsCount / events.length) * 1000) / 10,
      fallbackCallsCount,
      incompleteEvidenceCount,
      bloatAlertsCount,
      cacheHitsCount,
      totalSourceBytes,
      contextSavingsPercent,
      toolBreakdown,
      actionBreakdown,
      recentErrors: recentErrors.slice(-10).reverse(),
    };
  }
}

/**
 * Formats an ObservabilitySummary as clean Markdown for AI agents and human operators.
 */
export function formatSummaryAsText(summary: ObservabilitySummary): string {
  const lines: string[] = [
    `# Strata-MCP Observability & Performance Telemetry`,
    `- **Total Tool Calls Audited:** ${summary.totalCalls}`,
    `- **Success Rate:** ${summary.totalCalls > 0 ? (100 - summary.errorRatePercent).toFixed(1) : 0}% (${summary.successCount} succeeded, ${summary.errorCount} failed)`,
    `- **Latency (p50 / p95 / avg):** ${summary.p50DurationMs}ms / ${summary.p95DurationMs}ms / ${summary.avgDurationMs}ms`,
    `- **Slow Execution Warnings (>=250ms):** ${summary.slowCallsCount}`,
    `- **Empty-Result Rate:** ${summary.emptyResultRatePercent}% (${summary.emptyResultsCount} calls returned 0 items)`,
    `- **Fallback / Incomplete Evidence / Bloat:** ${summary.fallbackCallsCount} fallbacks, ${summary.incompleteEvidenceCount} partial, ${summary.bloatAlertsCount} bloat alerts`,
    `- **Total Payload Streamed:** ${(summary.totalBytesOut / 1024).toFixed(1)} KB`,
    `- **Total Domain Items Found:** ${summary.totalItemsFound}`,
    ...(summary.contextSavingsPercent !== null ? [`- **Context Savings (Slicing vs Full Source):** ${summary.contextSavingsPercent}% (${(summary.totalSourceBytes / 1024).toFixed(1)} KB raw)`] : []),
    '',
    `### Per-Tool Performance Breakdown:`,
    `| Tool Name | Calls | Errors | Latency (p50 / p95) | Items Found | Payload (KB) |`,
    `|---|---|---|---|---|---|`,
  ];

  const sortedTools = Object.keys(summary.toolBreakdown).sort();
  for (const tool of sortedTools) {
    const st = summary.toolBreakdown[tool];
    lines.push(
      `| \`${tool}\` | ${st.calls} | ${st.errors} | ${st.p50DurationMs}ms / ${st.p95DurationMs}ms | ${st.totalItemsFound} | ${(st.totalBytesOut / 1024).toFixed(1)} |`
    );
  }

  const sortedActions = Object.keys(summary.actionBreakdown).sort();
  if (sortedActions.length > 0) {
    lines.push('');
    lines.push(`### Per-Action Breakdown:`);
    for (const actionKey of sortedActions) {
      const a = summary.actionBreakdown[actionKey];
      lines.push(`- \`${actionKey}\`: ${a.calls} calls (${a.errors} errors, ${a.emptyResults} empty)`);
    }
  }

  if (summary.recentErrors.length > 0) {
    lines.push('');
    lines.push(`### Recent Failures & Diagnostics:`);
    for (const err of summary.recentErrors) {
      const codeStr = err.code ? ` [${err.code}]` : '';
      const stageStr = err.stage ? ` (stage: ${err.stage})` : '';
      lines.push(`- **\`${err.tool}\`** at \`${err.timestamp}\`${codeStr}${stageStr}: ${err.message}`);
    }
  }

  return lines.join('\n');
}
