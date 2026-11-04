import { expect, test } from 'bun:test';
import { withRetrievalEvidence } from '../../src/tools/retrieval-response';
import type { ToolCallResponse } from '../../src/tools/types';

function tool(response: ToolCallResponse) {
  return withRetrievalEvidence({ name: 'fixture', description: 'fixture', inputSchema: { type: 'object' }, handler: async () => response });
}

test('array JSON and existing mode metadata survive conservative evidence attachment', async () => {
  const original = '[{"file":"Child.vue"}]';
  const result = await tool({ content: [{ type: 'text', text: original }], structuredContent: { modeUsed: 'literal' } }).handler({ format: 'json' });
  expect(result.content[0].text).toBe(original);
  expect(result.structuredContent?.modeUsed).toBe('literal');
  const retrieval = result.structuredContent?.retrieval as any;
  expect(retrieval.freshness).toBe('unavailable');
  expect(retrieval.completeness).toBe('partial');
  expect(retrieval.workspace).toBeNull();
  expect(JSON.parse(result.content[1].text).retrieval).toEqual(retrieval);
});

test('NOT_INDEXED and stale error retain meaning and explicit limitations', async () => {
  const missing = await tool({ content: [{ type: 'text', text: '{"status":"NOT_INDEXED"}' }] }).handler({ format: 'json' });
  expect(JSON.parse(missing.content[0].text).status).toBe('NOT_INDEXED');
  expect((missing.structuredContent?.retrieval as any).omissions[0].code).toBe('NOT_INDEXED');
  const stale = await tool({ isError: true, content: [{ type: 'text', text: 'STALE_SOURCE_REF: changed' }] }).handler({});
  expect(stale.isError).toBe(true);
  expect((stale.structuredContent?.retrieval as any).freshness).toBe('stale');
});

test('specific evidence is not replaced and thrown failures do not become successful empty results', async () => {
  const specific = { content: [{ type: 'text' as const, text: 'source' }], structuredContent: { retrieval: { policy: 'specific' } } };
  const enriched = await tool(specific).handler({});
  expect(enriched.structuredContent?.retrieval).toBe(specific.structuredContent.retrieval);
  expect(enriched.content[0]).toEqual(specific.content[0]);
  const failing = withRetrievalEvidence({ name: 'fixture', description: '', inputSchema: { type: 'object' }, handler: async () => { throw new Error('PARSE_FAILED'); } });
  const result = await failing.handler({});
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe('PARSE_FAILED');
  expect((result.structuredContent?.retrieval as any).freshness).toBe('unavailable');
});
