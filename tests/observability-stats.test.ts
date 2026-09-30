import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrataTelemetry, formatSummaryAsText } from '../src/engine/telemetry';

describe('Strata Observability & Performance Telemetry', () => {
  const testWorkspace = join(process.cwd(), 'tests', 'mock-observability-workspace');
  const strataDir = join(testWorkspace, '.strata');
  const logFile = join(strataDir, 'strata.log');

  function cleanup() {
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  }

  it('handles empty or non-existent log gracefully', () => {
    cleanup();
    const summary = StrataTelemetry.getSummary(testWorkspace);
    expect(summary.totalCalls).toBe(0);
    expect(summary.successCount).toBe(0);
    expect(summary.errorCount).toBe(0);
    expect(summary.errorRatePercent).toBe(0);
    expect(summary.totalItemsFound).toBe(0);
  });

  it('aggregates telemetry events, percentiles, and items_found from .strata/strata.log', () => {
    cleanup();
    mkdirSync(strataDir, { recursive: true });

    // Seed mock telemetry entries with trace_id and session_id
    const mockEvents = [
      {
        timestamp: '2026-09-30T00:00:01.000Z',
        trace_id: 'trace-101',
        session_id: 'session-abc',
        event: 'tool_call_completed',
        tool: 'find_code',
        duration_ms: 10,
        input: { pattern: 'ref($$$)' },
        metrics: { bytes_out: 500, lines_out: 20, items_found: 5 },
        status: 'success',
      },
      {
        timestamp: '2026-09-30T00:00:02.000Z',
        trace_id: 'trace-101',
        session_id: 'session-abc',
        event: 'tool_call_completed',
        tool: 'find_code',
        duration_ms: 30,
        input: { pattern: 'computed($$$)' },
        metrics: { bytes_out: 1200, lines_out: 45, items_found: 12 },
        status: 'success',
      },
      {
        timestamp: '2026-09-30T00:00:03.000Z',
        trace_id: 'trace-102',
        session_id: 'session-abc',
        event: 'tool_call_completed',
        tool: 'inspect_component',
        duration_ms: 280, // slow query >= 250ms
        input: { path: 'App.vue' },
        metrics: { bytes_out: 3000, lines_out: 90, items_found: 8 },
        status: 'success',
      },
      {
        timestamp: '2026-09-30T00:00:04.000Z',
        trace_id: 'trace-103',
        session_id: 'session-abc',
        event: 'tool_call_failed',
        tool: 'inspect_component',
        duration_ms: 15,
        input: { path: 'Missing.vue' },
        status: 'error',
        error: { code: 'NOT_FOUND', message: 'File not found on disk' },
      },
    ];

    const jsonLines = mockEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(logFile, jsonLines, 'utf8');

    const summary = StrataTelemetry.getSummary(testWorkspace);

    expect(summary.totalCalls).toBe(4);
    expect(summary.successCount).toBe(3);
    expect(summary.errorCount).toBe(1);
    expect(summary.errorRatePercent).toBe(25);
    expect(summary.slowCallsCount).toBe(1);
    expect(summary.totalItemsFound).toBe(25);
    expect(summary.totalBytesOut).toBe(4700);

    // Latency percentiles
    expect(summary.p50DurationMs).toBeGreaterThan(0);
    expect(summary.p95DurationMs).toBeGreaterThanOrEqual(summary.p50DurationMs);

    // Tool breakdown
    expect(summary.toolBreakdown['find_code']).toBeDefined();
    expect(summary.toolBreakdown['find_code'].calls).toBe(2);
    expect(summary.toolBreakdown['find_code'].errors).toBe(0);
    expect(summary.toolBreakdown['find_code'].totalItemsFound).toBe(17);

    expect(summary.toolBreakdown['inspect_component']).toBeDefined();
    expect(summary.toolBreakdown['inspect_component'].calls).toBe(2);
    expect(summary.toolBreakdown['inspect_component'].errors).toBe(1);

    // Recent errors
    expect(summary.recentErrors.length).toBe(1);
    expect(summary.recentErrors[0].code).toBe('NOT_FOUND');
    expect(summary.recentErrors[0].tool).toBe('inspect_component');

    cleanup();
  });

  it('filters summary by specific tool name', () => {
    cleanup();
    mkdirSync(strataDir, { recursive: true });

    const mockEvents = [
      {
        event: 'tool_call_completed',
        tool: 'get_routes',
        duration_ms: 15,
        input: {},
        metrics: { bytes_out: 400, lines_out: 10, items_found: 4 },
        status: 'success',
      },
      {
        event: 'tool_call_completed',
        tool: 'find_code',
        duration_ms: 25,
        input: {},
        metrics: { bytes_out: 800, lines_out: 20, items_found: 2 },
        status: 'success',
      },
    ];

    writeFileSync(logFile, mockEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const routesOnly = StrataTelemetry.getSummary(testWorkspace, 500, 'get_routes');
    expect(routesOnly.totalCalls).toBe(1);
    expect(routesOnly.toolBreakdown['get_routes']).toBeDefined();
    expect(routesOnly.toolBreakdown['find_code']).toBeUndefined();

    cleanup();
  });

  it('formats telemetry summary as readable text and valid JSON', () => {
    cleanup();
    mkdirSync(strataDir, { recursive: true });

    const mockEvent = {
      event: 'tool_call_completed',
      tool: 'get_api_contracts',
      duration_ms: 12,
      input: {},
      metrics: { bytes_out: 600, lines_out: 15, items_found: 3 },
      status: 'success',
    };
    writeFileSync(logFile, JSON.stringify(mockEvent) + '\n', 'utf8');

    const summary = StrataTelemetry.getSummary(testWorkspace);

    // Test text format
    const textOut = formatSummaryAsText(summary);
    expect(textOut).toContain('# Strata-MCP Observability & Performance Telemetry');
    expect(textOut).toContain('get_api_contracts');

    // Test json format
    const jsonStr = JSON.stringify(summary, null, 2);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.totalCalls).toBe(1);
    expect(parsed.totalItemsFound).toBe(3);
    expect(parsed.toolBreakdown['get_api_contracts']).toBeDefined();

    cleanup();
  });
});
