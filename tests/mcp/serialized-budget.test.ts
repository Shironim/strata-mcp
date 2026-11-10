import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRetrievalEvidence } from '../../src/tools/retrieval-response';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { applyContextBudget, decodeAndVerifyContinuationToken, encodeContinuationToken, enforceResponseLimit, measureResponseBytes } from '../../src/engine/context-budget';
import { createMcpServer } from '../../src/mcp';
import type { ToolCallResponse } from '../../src/tools/types';

function fixture(name: string, response: ToolCallResponse) {
  return withRetrievalEvidence({ name, description: '', inputSchema: { type: 'object' }, handler: async () => response });
}
const items = Array.from({ length: 35 }, (_, id) => ({ id, file: `file-${String(id).padStart(3, '0')}.vue`, line: id + 1,
  snippet: `${id}: ${'é🙂"\\\n'.repeat(60)}` }));

test('full UTF-8 serialization fits and text/JSON pages expose only the selected matches', async () => {
  for (const format of ['text', 'json']) {
    const original = { content: [{ type: 'text' as const, text: `UNPAGED_TEXT_MUST_NOT_LEAK ${JSON.stringify(items)}` }], structuredContent: { matches: items, matchCount: items.length } };
    const before = JSON.stringify(original);
    const tool = fixture('find_code', original);
    let continuation_token: string | undefined;
    const collected: number[] = [];
    let pages = 0;
    do {
      const result = await tool.handler({ path: '/fixture', pattern: 'sentinel', format, max_bytes: 16000, continuation_token });
      expect(result.isError).not.toBe(true);
      expect(measureResponseBytes(result)).toBeLessThanOrEqual(16000);
      expect(result.content[0]!.text).not.toContain('UNPAGED_TEXT_MUST_NOT_LEAK');
      const data = result.structuredContent as any;
      expect(data).not.toHaveProperty('cost');
      expect(data.retrieval.budget.estimatedBytes).toBe(measureResponseBytes(result));
      if (format === 'json') {
        expect(JSON.parse(result.content[0]!.text).matches).toEqual(data.matches);
      } else {
        expect(() => JSON.parse(result.content[0]!.text)).toThrow();
        const selectedFiles = new Set(data.matches.map((item: any) => item.file));
        for (const selectedFile of selectedFiles) {
          expect(result.content[0]!.text).toContain(selectedFile);
        }
        for (const item of items) {
          if (!selectedFiles.has(item.file)) {
            expect(result.content[0]!.text).not.toContain(item.file);
          }
        }
      }
      expect(data.matches.length).toBeGreaterThan(0);
      expect(data.offset).toBe(collected.length);
      collected.push(...data.matches.map((item: any) => item.id));
      continuation_token = data.continuationToken;
      expect(++pages).toBeLessThan(40);
    } while (continuation_token);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(items.map(item => item.id));
    expect(JSON.stringify(original)).toBe(before);
  }
});

test('512-byte accepted budgets return a bounded error instead of an empty success', async () => {
  const tool = fixture('find_code', { content: [], structuredContent: { matches: items } });
  const result = await tool.handler({ max_bytes: 512 });
  expect(result.isError).toBe(true);
  expect(measureResponseBytes(result)).toBeLessThanOrEqual(512);
  expect(result.content[0]!.text).toContain('BUDGET_METADATA_TOO_LARGE');
  expect(result.structuredContent?.decision).toMatchObject({ status: 'unknown', emptyOutcome: 'analysis-failed' });
  const budget = result.structuredContent?.budget as any;
  expect(budget.responseBytes).toBe(measureResponseBytes(result));
  expect(budget.retryMaxBytes).toBeGreaterThan(budget.requiredBytes);
  const retry = await tool.handler({ max_bytes: budget.retryMaxBytes });
  expect(retry.isError).not.toBe(true);
  expect(measureResponseBytes(retry)).toBeLessThanOrEqual(budget.retryMaxBytes);
});

test('atomic oversized items and mandatory metadata are rejected without zero-progress tokens', async () => {
  const huge = '🙂'.repeat(30000);
  for (const [response, code] of [
    [{ content: [], structuredContent: { matches: [{ file: 'huge.vue', snippet: huge }] } }, 'BUDGET_ITEM_TOO_LARGE'],
    [{ content: [], structuredContent: { matches: items, mandatoryContext: huge } }, 'BUDGET_METADATA_TOO_LARGE'],
  ] as const) {
    const result = await fixture('find_code', response as unknown as ToolCallResponse).handler({ max_bytes: 16000 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(code);
    expect(measureResponseBytes(result)).toBeLessThanOrEqual(16000);
    expect(result.structuredContent?.continuationToken).toBeUndefined();
  }
  expect(() => applyContextBudget([huge], { maxBytes: 512 })).toThrow('BUDGET_ITEM_TOO_LARGE');
  expect(() => applyContextBudget(items, { maxItems: 0 })).toThrow('INVALID_ITEM_LIMIT');
});

test('nested trees remain atomic per root neighbor; multiple selected collections are not silently dropped', async () => {
  const root = { children: [{ file: 'Child.vue', children: [{ file: 'Grandchild.vue', source: 'x'.repeat(50000) }] }] };
  const tree = await fixture('get_component_tree', { content: [], structuredContent: { root } }).handler({ path: 'App.vue', max_bytes: 16000 });
  expect(tree.isError).toBe(true);
  expect(tree.content[0]!.text).toContain('BUDGET_ITEM_TOO_LARGE');
  const chain = await fixture('trace_state', { content: [], structuredContent: { consumers: items, dependencies: items } }).handler({ direction: 'both', max_bytes: 16000 });
  expect(chain.isError).toBe(true);
  expect(measureResponseBytes(chain)).toBeLessThanOrEqual(16000);
});

test('exact source text survives an adequate budget; oversized source is not cut mid-file', async () => {
  const source = 'const text = "é🙂";\n';
  const tool = fixture('inspect_component', { content: [{ type: 'text', text: source }], structuredContent: { source } });
  const result = await tool.handler({ path: 'source.ts', view: 'source', max_bytes: 16000 });
  expect(result.isError).not.toBe(true);
  expect(result.content[0]!.text).toBe(source);
  expect(measureResponseBytes(result)).toBeLessThanOrEqual(16000);
  const large = await fixture('inspect_component', { content: [{ type: 'text', text: source.repeat(5000) }], structuredContent: { source: source.repeat(5000) } }).handler({ path: 'source.ts', view: 'source', max_bytes: 16000 });
  expect(large.isError).toBe(true);
  expect(large.content[0]!.text).toContain('BUDGET_METADATA_TOO_LARGE');
});

test('large errors stay bounded and preserve stale/original-code diagnosis', async () => {
  const result = await fixture('find_code', { isError: true, content: [{ type: 'text', text: `STALE_SOURCE_REF: ${'x'.repeat(30000)}` }] }).handler({ max_bytes: 512 });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('STALE_SOURCE_REF');
  expect((result.structuredContent?.decision as any).status).toBe('stale');
  expect(measureResponseBytes(result)).toBeLessThanOrEqual(512);
});

test('malformed continuation offsets cannot create non-progressing pages', () => {
  const expected = { tool: 'find_code', queryId: 'q', engineRevision: 'r' };
  for (const offset of [-1, 0.5, '0', null]) {
    const token = encodeContinuationToken({ version: 1, ...expected, offset, totalItems: 5, issuedAt: 0 } as any);
    expect(decodeAndVerifyContinuationToken(token, expected).valid).toBe(false);
  }
  expect(decodeAndVerifyContinuationToken(Buffer.from('null').toString('base64url'), expected).valid).toBe(false);
});

test('non-integer budgets reject before running the analyzer', async () => {
  let calls = 0;
  const tool = withRetrievalEvidence({ name: 'find_code', description: '', inputSchema: { type: 'object' }, handler: async () => { calls++; return { content: [] }; } });
  for (const max_bytes of [NaN, Infinity, 512.5, '512', Number.MAX_SAFE_INTEGER + 1]) {
    expect((await tool.handler({ max_bytes })).isError).toBe(true);
  }
  expect(calls).toBe(0);
});

test('transport guard bounds failures that bypass the tool wrapper', async () => {
  const huge = { isError: true, content: [{ type: 'text' as const, text: `${'A'.repeat(5000)}: failure` }] };
  expect(measureResponseBytes(enforceResponseLimit(huge, 512))).toBeLessThanOrEqual(512);
  const server = createMcpServer();
  try {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const result = await handler({ method: 'tools/call', params: { name: 'missing'.repeat(500), arguments: { max_bytes: 512 } } });
    expect(result.isError).toBe(true);
    expect(measureResponseBytes(result)).toBeLessThanOrEqual(512);
  } finally { await server.close(); }
});

test('budget pagination preserves inventory-window coverage and original truncation', async () => {
  const tool = fixture('find_code', { content: [], structuredContent: {
    files: items, coverage: { knownFiles: 300, returnedFiles: items.length, offset: 50, limit: 35, truncated: true },
  } });
  const first = await tool.handler({ action: 'map', max_bytes: 16000, format: 'json' });
  expect(first.isError).not.toBe(true);
  const data = first.structuredContent as any;
  expect(data.coverage.knownFiles).toBe(300);
  expect(data.coverage.offset).toBe(50);
  expect(data.coverage.returnedFiles).toBe(data.files.length);
  const second = await tool.handler({ action: 'map', max_bytes: 16000, format: 'json', continuation_token: data.continuationToken });
  expect(second.isError).not.toBe(true);
  const page = second.structuredContent as any;
  expect(page.coverage.knownFiles).toBe(300);
  expect(page.coverage.offset).toBe(50 + data.files.length);
  expect(page.isTruncated).toBe(true);
  expect(measureResponseBytes(second)).toBeLessThanOrEqual(16000);
});

test('all six wrappers default to 16 KiB and retain safety evidence when paging or rejecting', async () => {
  const diagnostic = { code: 'UNRESOLVED', reason: 'Dynamic binding requires review' };
  const samples = [
    ['find_code', {}, { matches: items }],
    ['inspect_component', { symbol: 'large' }, { source: 'é🙂'.repeat(10000) }],
    ['get_component_tree', {}, { root: { children: items } }],
    ['trace_state', {}, { consumers: items }],
    ['audit_frontend', { target: 'routes' }, { routes: items }],
    ['generate_patch_plan', { refactor_type: 'rename_prop' }, { patches: items }],
  ] as const;
  for (const [name, args, payload] of samples) {
    const tool = fixture(name, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { ...payload, diagnostics: [diagnostic] } });
    const response = await tool.handler(args);
    expect(measureResponseBytes(response)).toBeLessThanOrEqual(16384);
    const data = response.structuredContent as any;
    if (!response.isError) {
      expect(data.diagnostics).toEqual([diagnostic]);
      expect(data.retrieval.completeness).toBe('partial');
      expect(data.continuationToken).toBeDefined();
    } else expect(response.content[0]!.text).toContain('BUDGET_');
    const larger = await tool.handler({ ...args, max_bytes: 2000000 });
    expect(larger.isError).not.toBe(true);
    expect(larger.structuredContent?.diagnostics).toEqual([diagnostic]);
  }
});

test('contract output excludes unrequested impact and unrelated API capabilities', async () => {
  const response = await fixture('inspect_component', { content: [{ type: 'text', text: '{"props":[]}' }], structuredContent: { props: [] } }).handler({ path: 'Child.vue', response_detail: 'summary' });
  const data = response.structuredContent as any;
  expect(data.decision.capability.features.map((item: any) => item.id)).not.toContain('consumer-count-per-prop');
  expect(data.decision.capability.features.map((item: any) => item.id)).not.toContain('imported-composable-api');
  expect(data.decision.capability.limitations).toHaveLength(1);
  expect(response.content).toHaveLength(1);
  const mirror = JSON.parse(response.content[0]!.text);
  expect(mirror.resultSummary).toEqual(data.resultSummary);
  expect(mirror.retrieval).toEqual(data.retrieval);
  expect(mirror.decision.status).toBe(data.decision.status);
  expect(mirror.decision.capability.features).toBeUndefined();
  expect(new Set(mirror.decision.capability.limitations).size).toBe(mirror.decision.capability.limitations.length);
  expect(mirror.decision.capability.limitations.some((reason: string) => reason.includes('runtime behavior not certified'))).toBe(true);
  expect(data).not.toHaveProperty('cost');
});

test('exact JSON-shaped source remains byte-for-byte intact under the default budget', async () => {
  const source = '{ "answer": "é🙂" }\n';
  const response = await fixture('inspect_component', { content: [{ type: 'text', text: source }], structuredContent: { source } }).handler({ path: 'data.ts', view: 'source' });
  expect(response.content[0]!.text).toBe(source);
  expect(measureResponseBytes(response)).toBeLessThanOrEqual(16384);
});

test('paginated inspect_component outline preserves Markdown formatting across continuation pages in text mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-outline-page-'));
  try {
    const file = join(dir, 'browser-manager.ts');
    const fns = Array.from({ length: 39 }, (_, i) => `export function manageBrowserAction_${String(i).padStart(2, '0')}(x: number) {\n  return x + ${i};\n}`);
    await writeFile(file, fns.join('\n\n'));

    let continuation_token: string | undefined;
    const collectedNames: string[] = [];
    let pages = 0;
    do {
      const res = await inspectComponentTool.handler({
        path: file,
        project_root: dir,
        outline: true,
        format: 'text',
        max_bytes: 7500,
        continuation_token,
      });
      expect(res.isError).not.toBe(true);
      expect(measureResponseBytes(res)).toBeLessThanOrEqual(7500);
      const primaryText = res.content[0]!.text;
      expect(() => JSON.parse(primaryText)).toThrow();
      expect(primaryText).toContain('### Component Symbol Outline:');
      expect(primaryText).toContain('| Function / Symbol | Kind | Range | Lines | Exported |');
      expect(primaryText).toContain('Page: entries ');
      const data = res.structuredContent as any;
      expect(data.functions.length).toBeGreaterThan(0);
      for (const fn of data.functions) {
        expect(primaryText).toContain(fn.name);
        collectedNames.push(fn.name);
      }
      continuation_token = data.continuationToken;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (continuation_token);

    expect(pages).toBeGreaterThan(1);
    expect(collectedNames).toHaveLength(39);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
