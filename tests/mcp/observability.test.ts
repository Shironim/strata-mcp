import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrataTelemetry } from '../../src/engine/telemetry';

describe('StrataTelemetry Engine', () => {
  const testDir = join(import.meta.dir, '../fixtures/temp-telemetry-test');
  const logFile = join(testDir, '.strata', 'strata.log');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('records tool call completions into .strata/strata.log as JSON Lines', () => {
    StrataTelemetry.recordToolCall(
      {
        event: 'tool_call_completed',
        tool: 'inspect_component',
        duration_ms: 15,
        input: { path: 'src/Button.vue' },
        metrics: { bytes_out: 320, lines_out: 14, items_found: 4 },
        status: 'success',
      },
      testDir
    );

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, 'utf8').trim();
    const parsed = JSON.parse(content);

    expect(parsed.event).toBe('tool_call_completed');
    expect(parsed.tool).toBe('inspect_component');
    expect(parsed.duration_ms).toBe(15);
    expect(parsed.metrics.bytes_out).toBe(320);
    expect(parsed.status).toBe('success');
  });

  it('records tool call failures with error diagnostics', () => {
    StrataTelemetry.recordToolCall(
      {
        event: 'tool_call_failed',
        tool: 'trace_state',
        duration_ms: 8,
        input: { identifier: 'badState' },
        status: 'error',
        error: { code: 'NOT_FOUND', message: 'Identifier not found' },
      },
      testDir
    );

    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.event).toBe('tool_call_failed');
    expect(last.status).toBe('error');
    expect(last.error.message).toBe('Identifier not found');
  });

  it('rotates log file when size reaches 2MB threshold', () => {
    // Pre-create log file near 2MB
    const bigData = 'X'.repeat(2 * 1024 * 1024);
    StrataTelemetry.recordToolCall(
      { event: 'tool_call_completed', tool: 'init', duration_ms: 1, input: {}, status: 'success' },
      testDir
    );
    writeFileSync(logFile, bigData, 'utf8');

    // Trigger next write
    StrataTelemetry.recordToolCall(
      { event: 'tool_call_completed', tool: 'after_rotation', duration_ms: 2, input: {}, status: 'success' },
      testDir
    );

    const rotatedFile = `${logFile}.1`;
    expect(existsSync(rotatedFile)).toBe(true);
    expect(existsSync(logFile)).toBe(true);
  });
});
