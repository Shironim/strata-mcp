import { expect, test } from 'bun:test';
import { findCodeTool } from '../../src/tools/find-code';

test('inline literal search aliases share normalized identity and preserve mode metadata', async () => {
  const first = await findCodeTool.handler({ code: 'const title = "café";', pattern: 'title', mode: 'literal', format: 'json' });
  const alias = await findCodeTool.handler({ code_snippet: 'const title = "café";', query: 'title', mode: 'literal', output_format: 'json' });
  const original = first.structuredContent?.retrieval as any;
  const normalized = alias.structuredContent?.retrieval as any;
  expect(normalized.queryId).toBe(original.queryId);
  expect(normalized.inputIdentity).toEqual(original.inputIdentity);
  expect(first.structuredContent?.modeUsed).toBe('literal');
  expect(original.freshness).toBe('unavailable');
  const changed = await findCodeTool.handler({ code: 'const title = "new";', pattern: 'title', mode: 'literal', format: 'json' });
  expect((changed.structuredContent?.retrieval as any).inputIdentity.hash).not.toBe(original.inputIdentity.hash);
});
