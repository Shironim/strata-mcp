import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StrataTelemetry } from '../../src/engine/telemetry';

test('telemetry does not retain large source inputs or unbounded errors', () => {
  const root = mkdtempSync('/tmp/strata-telemetry-');
  try {
    mkdirSync(join(root, '.strata'), { recursive: true });
    StrataTelemetry.recordToolCall({ event: 'tool_call_failed', tool: 'find_code', duration_ms: 1, status: 'error', input: {code: 'sensitive-source'.repeat(10000)}, error: {message: 'failure'.repeat(10000), stack: 'stack'.repeat(10000)} }, root);
    const log = readFileSync(join(root, '.strata/strata.log'), 'utf8');
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(4096);
    expect(log).not.toContain('sensitive-source');
    expect(JSON.parse(log).error.message).toContain('failure');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('telemetry does not auto-create .strata directory in uninitialized workspaces', () => {
  const root = mkdtempSync('/tmp/strata-telemetry-empty-');
  try {
    StrataTelemetry.recordToolCall({ event: 'tool_call_completed', tool: 'find_code', duration_ms: 5, status: 'success', input: { query: 'test' } }, root);
    expect(existsSync(join(root, '.strata'))).toBe(false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
