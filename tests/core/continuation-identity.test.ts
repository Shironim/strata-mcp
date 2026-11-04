import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyContextBudget, applyResponseBudget, decodeAndVerifyContinuationToken, encodeContinuationToken, measureResponseBytes } from '../../src/engine/context-budget';
import { findCodeTool } from '../../src/tools/find-code';

test('missing, changed, and lost declared identities reject continuation', () => {
  const base = { version: 1 as const, tool: 'find_code', queryId: 'q', engineRevision: 'engine', offset: 1, totalItems: 3, issuedAt: 0 };
  for (const field of ['sourceHash', 'indexGeneration', 'configFingerprint', 'engineRevision']) {
    const expected = { tool: 'find_code', queryId: 'q', [field]: 'original' };
    for (const replacement of [undefined, null, '', 7, 'changed']) {
      const token = encodeContinuationToken({ ...base, [field]: replacement } as any);
      expect(decodeAndVerifyContinuationToken(token, expected).valid).toBe(false);
    }
    const token = encodeContinuationToken({ ...base, [field]: 'original' });
    expect(decodeAndVerifyContinuationToken(token, expected).valid).toBe(true);
    expect(decodeAndVerifyContinuationToken(token, { ...expected, [field]: null } as any).valid).toBe(false);
  }
});

test('same-sized collection mutation, including nested neighbors, invalidates response tokens', () => {
  const context = { tool: 'get_component_tree', queryId: 'q', engineRevision: 'e' };
  const children = Array.from({ length: 20 }, (_, id) => ({ filePath: `/fixture/${id}.vue`, depth: 1,
    children: [{ filePath: `/fixture/leaf-${id}.vue`, snippet: 'x'.repeat(200) }] }));
  const run = (nodes: typeof children, token?: string) => applyResponseBudget({ content: [], structuredContent: { root: { children: nodes } } }, {
    tool: context.tool, tokenContext: context, collectionPaths: ['root.children'], maxBytes: 5000, continuationToken: token,
  });
  const first = run(children);
  expect(first.isError).not.toBe(true);
  const token = first.structuredContent?.continuationToken as string;
  expect(token).toBeString();
  expect(run(children, token).isError).not.toBe(true);
  const changed = structuredClone(children);
  changed[0]!.children[0]!.filePath = '/fixture/replaced.vue';
  const stale = run(changed, token);
  expect(stale.isError).toBe(true);
  expect(stale.content[0]!.text).toContain('STALE_CONTINUATION_TOKEN');
  const legacy = JSON.parse(Buffer.from(token, 'base64url').toString());
  delete legacy.selectionHash;
  expect(run(children, encodeContinuationToken(legacy)).isError).toBe(true);
});

test('collection helper binds all items and canonical object keys without including page size', () => {
  const context = { tool: 'find_code', queryId: 'q', engineRevision: 'e' };
  const items = Array.from({ length: 12 }, (_, id) => ({ name: `item-${id}`, nested: { value: id, label: 'é🙂' } }));
  const first = applyContextBudget(items, { maxItems: 3, tokenContext: context });
  const token = first.continuationToken!;
  const equivalent = items.map(item => ({ nested: { label: item.nested.label, value: item.nested.value }, name: item.name }));
  const second = applyContextBudget(equivalent, { maxItems: 4, tokenContext: context, continuationToken: token });
  expect(second.offset).toBe(3);
  expect(second.items.map(item => item.name)).toEqual(['item-3', 'item-4', 'item-5', 'item-6']);
  const changed = structuredClone(items);
  changed[11]!.nested.value = 99;
  expect(() => applyContextBudget(changed, { maxItems: 3, tokenContext: context, continuationToken: token })).toThrow('STALE_CONTINUATION_TOKEN');
});

test('disk search rejects same-count source changes between pages and accepts an unchanged query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-continuation-'));
  try {
    const file = join(root, 'App.vue');
    const source = (version: string) => '<template>\n' + Array.from({ length: 35 }, (_, id) =>
      `<div>SENTINEL ${version} ${id} ${'x'.repeat(300)}</div>`).join('\n') + '\n</template>';
    await writeFile(file, source('OLD'));
    const args = { path: root, pattern: 'SENTINEL', mode: 'literal', format: 'json', max_bytes: 16000 };
    const first = await findCodeTool.handler(args);
    expect(first.isError).not.toBe(true);
    const token = first.structuredContent?.continuationToken;
    expect(token).toBeString();
    const unchanged = await findCodeTool.handler({ ...args, continuation_token: token });
    expect(unchanged.isError).not.toBe(true);
    await writeFile(file, source('NEW'));
    const changed = await findCodeTool.handler({ ...args, continuation_token: token });
    expect(changed.isError).toBe(true);
    expect(changed.content[0]!.text).toContain('STALE_CONTINUATION_TOKEN');
    expect(changed.structuredContent?.decision).toMatchObject({ status: 'stale', emptyOutcome: 'analysis-failed' });
    expect(changed.structuredContent?.matches).toBeUndefined();
    const small = await findCodeTool.handler({ ...args, max_bytes: 512, continuation_token: token });
    expect(small.isError).toBe(true);
    expect(small.content[0]!.text).toContain('STALE_CONTINUATION_TOKEN');
    expect(small.structuredContent?.decision).toMatchObject({ status: 'stale' });
    expect(measureResponseBytes(small)).toBeLessThanOrEqual(512);
    const fresh = await findCodeTool.handler(args);
    expect(fresh.isError).not.toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
