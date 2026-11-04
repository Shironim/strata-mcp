import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrataTelemetry, type StrataToolCallEvent } from '../src/engine/telemetry';
import { createMcpServer } from '../src/mcp';
import { clearLastKnownProjectRoot } from '../src/engine/path-resolver';

let root: string;
let originalPreview: string | undefined;
const event: StrataToolCallEvent = {
  event: 'tool_call_completed', tool: 'find_code', action: 'search',
  duration_ms: 1, status: 'success', input: { code: 'private source', pattern: 'secret' },
};
const entries = () => readFileSync(StrataTelemetry.getLogPath(root), 'utf8').trim().split('\n').map(line => JSON.parse(line));

beforeEach(() => {
  root = mkdtempSync('/tmp/strata-tool-log-');
  mkdirSync(join(root, '.strata'));
  originalPreview = process.env.STRATA_LOG_PREVIEW;
  delete process.env.STRATA_LOG_PREVIEW;
});
afterEach(() => {
  if (originalPreview === undefined) delete process.env.STRATA_LOG_PREVIEW;
  else process.env.STRATA_LOG_PREVIEW = originalPreview;
  clearLastKnownProjectRoot();
  rmSync(root, { recursive: true, force: true });
});

test('writes JSONL metrics for the final UTF-8 response without retaining source or changing output', () => {
  const response = { content: [{ type: 'text', text: 'é🙂\nsecond' }, { type: 'text', text: 'third' }] };
  const before = JSON.stringify(response);
  StrataTelemetry.recordToolResponse(event, response, root);
  StrataTelemetry.recordToolResponse(event, { content: [] }, root);
  const [entry, empty] = entries();
  const bytes = Buffer.byteLength('é🙂\nsecondthird');
  expect(entry.metrics).toEqual({ bytes_out: bytes, lines_out: 3, estimated_tokens: Math.round(bytes / 4), response_bytes: Buffer.byteLength(before) });
  expect(entry.action).toBe('search');
  expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(entry.input.code).toEqual({ bytes: 14 });
  expect(entry.output_digest).toEqual({ summary: 'preview_disabled' });
  expect(empty.output_digest.summary).toBe('empty_output');
  expect(JSON.stringify(response)).toBe(before);
  expect(readFileSync(StrataTelemetry.getLogPath(root), 'utf8')).not.toContain('private source');
});

test('detects bloat at the threshold including structuredContent and warns only on stderr', () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const base = { content: [{ text: '' }], structuredContent: { value: '' } };
    const padding = StrataTelemetry.BLOAT_BYTE_THRESHOLD - Buffer.byteLength(JSON.stringify(base));
    for (const size of [padding - 1, padding]) {
      StrataTelemetry.recordToolResponse(event, { ...base, structuredContent: { value: 'x'.repeat(size) } } as typeof base, root);
    }
    expect(entries().map(entry => entry.bloat_alert)).toEqual([false, true]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('BLOAT_WARN');
    expect(stdout).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); stdout.mockRestore(); }
});

test('digest normalizes whitespace and caps head/omission/tail to 300 characters', () => {
  expect(StrataTelemetry.createOutputDigest(' \n\t ')).toEqual({ summary: 'empty_output' });
  expect(StrataTelemetry.createOutputDigest(' hello\n world ')).toEqual({ sample_preview: 'hello world' });
  const text = 'HEAD' + 'x'.repeat(2000) + 'TAIL';
  const preview = StrataTelemetry.createOutputDigest(text).sample_preview!;
  expect(preview.length).toBeLessThanOrEqual(300);
  expect(preview.startsWith('HEAD')).toBe(true);
  expect(preview.endsWith('TAIL')).toBe(true);
  expect(preview).toContain('chars omitted');
  expect(StrataTelemetry.createOutputDigest(text, 5).sample_preview!.length).toBeLessThanOrEqual(5);
});

test('output preview requires explicit environment opt-in', () => {
  process.env.STRATA_LOG_PREVIEW = '1';
  StrataTelemetry.recordToolResponse(event, { content: [{ text: 'head\n' + 'x'.repeat(2000) + 'tail' }] }, root);
  expect(entries()[0].output_digest.sample_preview.length).toBeLessThanOrEqual(300);
});

test('rotates before a write would exceed 2 MiB and replaces the previous backup', () => {
  const path = StrataTelemetry.getLogPath(root);
  writeFileSync(path, 'x'.repeat(StrataTelemetry.MAX_LOG_SIZE_BYTES - 1));
  writeFileSync(path + '.1', 'old backup');
  StrataTelemetry.recordToolResponse(event, { content: [{ text: 'ok' }] }, root);
  expect(statSync(path + '.1').size).toBe(StrataTelemetry.MAX_LOG_SIZE_BYTES - 1);
  expect(entries()).toHaveLength(1);
  expect(statSync(path).size).toBeLessThanOrEqual(4096);
});

test('stderr failure still persists error diagnostics; file failure never escapes', () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('broken pipe'); });
  try {
    const failure: StrataToolCallEvent = { ...event, event: 'tool_call_failed', status: 'error', error: { code: 'TEST_ERROR', message: 'diagnosis', stack: 'private stack' } };
    expect(() => StrataTelemetry.recordToolResponse(failure, { content: [{ text: 'error' }] }, root)).not.toThrow();
    expect(entries()[0].error).toEqual({ code: 'TEST_ERROR', message: 'diagnosis' });
    rmSync(StrataTelemetry.getLogPath(root));
    mkdirSync(StrataTelemetry.getLogPath(root));
    expect(() => StrataTelemetry.recordToolResponse(failure, { content: [] }, root)).not.toThrow();
    const circular: any = {}; circular.self = circular;
    expect(() => StrataTelemetry.recordToolResponse(event, circular, root)).not.toThrow();
  } finally { stderr.mockRestore(); }
});

test('dispatcher records each of the six tools and unknown/worker failures once, with final result metrics', async () => {
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  const path = join(root, 'App.vue');
  writeFileSync(path, '<template><div /></template>');
  const server = createMcpServer();
  const calls = [
    ['find_code', { action: 'map' }],
    ['inspect_component', { path, view: 'map' }],
    ['get_component_tree', { path, direction: 'upward' }],
    ['trace_state', { path, identifier: 'missing', direction: 'both' }],
    ['audit_frontend', { path: root, target: 'routes' }],
    ['generate_patch_plan', { path, refactor_type: 'rename_prop', old_name: 'label', new_name: 'title' }],
    ['find_code', { pattern: '   ' }],
    ['unknown_tool', {}],
    ['find_code', { code: 'x'.repeat(2 * 1024 * 1024 + 1) }],
  ] as const;
  try {
    const handler = (server as any)._requestHandlers.get('tools/call');
    for (const [name, args] of calls) {
      const response = await handler({ method: 'tools/call', params: { name, arguments: { root, ...args, trace_id: 'test-trace' } } });
      const logs = entries();
      const entry = logs[logs.length - 1];
      expect(entry.tool).toBe(name);
      expect(entry.trace_id).toBe('test-trace');
      expect(entry.metrics.response_bytes).toBe(Buffer.byteLength(JSON.stringify(response)));
      expect(entry.status).toBe(response.isError ? 'error' : 'success');
      expect(response.metrics).toBeUndefined();
    }
    expect(entries()).toHaveLength(calls.length);
    expect(entries().slice(0, 6).map(entry => entry.action)).toEqual(['map', 'map', 'upward', 'both', 'routes', 'rename_prop']);
    expect(entries().at(-2).error.code).toBe('UNKNOWN_TOOL');
    expect(entries().at(-3).error.code).toBe('HANDLER_ERROR');
    expect(entries().at(-1).error.code).toBe('REQUEST_TOO_LARGE');
  } finally { await server.close(); }
}, 30000);
