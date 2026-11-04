import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { interpretSearchIntent } from '../../src/engine/search-intent';
import { findCodeTool } from '../../src/tools/find-code';

test('bounded intent grammar has explicit Indonesian/English interpretations and rejects unsupported language', () => {
  for (const intent of ['komponen Child yang memakai prop title', 'komponen Child menggunakan prop title', 'component Child using prop title', 'component Child uses prop title'])
    expect(interpretSearchIntent(intent)).toEqual({ component: 'Child', prop: 'title', operation: 'component-prop-usages' });
  for (const intent of ['komponen Child tanpa prop title', 'komponen Child yang tidak memakai prop title', 'komponen Child tidak menggunakan prop title', 'component Child omitting prop title', 'component Child without prop title'])
    expect(interpretSearchIntent(intent)).toEqual({ component: 'Child', prop: 'title', operation: 'component-prop-omissions' });
  for (const intent of ['', 'find something like Child', 'component Child using event save', 'komponen Child yang memakai prop title dan count', 'component Child without prop title and count', 'component Child without event save', 7])
    expect(() => interpretSearchIntent(intent)).toThrow('UNSUPPORTED_SEARCH_INTENT');
});

test('omission intent returns exact resolved render refs, preserves uncertainty and never treats forwarding as absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-intent-omission-'));
  try {
    await writeFile(join(root, 'Child.vue'), '<script setup>defineProps({ title: String })</script><template><div/></template>');
    const source = '<script setup>import Alias from "./Child.vue"</script>\r\n<template><!-- 🙂 --><Alias/><Alias title="yes"/><Alias v-bind="attrs"/><Alias :[key]="value"/><Alias v-model:[model]="value"/><Alias v-for="Alias in list"/><component :is="selected"/></template>';
    await writeFile(join(root, 'Parent.vue'), source);
    await writeFile(join(root, 'Candidate.vue'), '<template><Child/></template>');
    const args = { path: root, format: 'json', intent: 'component Child omitting prop title' };
    const response = await findCodeTool.handler(args);
    expect(response.isError).not.toBe(true);
    const data = response.structuredContent as any;
    expect(data.interpretation.query.operation).toBe('component-prop-omissions');
    expect(data.interpretation.grammar).toBe('component-prop-omission-v1');
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ snippet: '<Alias/>', resolution: 'resolved', line: 2 });
    const ref = data.matches[0].sourceRef;
    expect(source.slice(ref.startOffset, ref.endOffset)).toBe('<Alias/>');
    expect(ref.sha256).toBe(new Bun.CryptoHasher('sha256').update(source).digest('hex'));
    expect(data.coverage.propSupply).toMatchObject({ omittedRenderCount: 1, omittedConsumerCount: 1, indeterminateRenderCount: 3 });
    expect(data.decision.status).toBe('partial');
    const usage = await findCodeTool.handler({ ...args, intent: 'component Child using prop title' });
    expect((usage.structuredContent as any).retrieval.queryId).not.toBe(data.retrieval.queryId);
    const summary = await findCodeTool.handler({ ...args, response_detail: 'summary' });
    expect((summary.structuredContent as any).interpretation).toEqual(data.interpretation);
    expect((summary.structuredContent as any).coverage.propSupply).toEqual(data.coverage.propSupply);
    expect((summary.structuredContent as any).resultSummary.selection.count).toBe(1);
    const text = await findCodeTool.handler({ ...args, format: 'text' });
    expect(text.content[0]!.text).toContain('component-prop-omissions');
    expect(text.content[0]!.text).toContain('"indeterminateRenderCount":3');
    await writeFile(join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue"</script><template><Child v-bind="attrs"/></template>');
    const empty = await findCodeTool.handler(args);
    expect(empty.structuredContent?.matches).toEqual([]);
    expect((empty.structuredContent as any).coverage.propSupply.indeterminateRenderCount).toBe(1);
    expect((empty.structuredContent as any).decision.emptyOutcome).toBe('inconclusive');
    for (const extra of [{ pattern: 'title' }, { mode: 'literal' }, { action: 'map' }])
      expect((await findCodeTool.handler({ ...args, ...extra })).content[0]!.text).toContain('INTENT_SELECTOR_CONFLICT');
    expect((await findCodeTool.handler({ ...args, path: join(root, 'Child.vue') })).content[0]!.text).toContain('INVALID_INTENT_SCOPE');
    expect((await findCodeTool.handler({ ...args, intent: 'component Missing without prop title' })).content[0]!.text).toContain('INTENT_COMPONENT_NOT_FOUND');
    await writeFile(join(root, 'Other.tsx'), 'export const Other = () => null');
    expect((await findCodeTool.handler({ ...args, intent: 'component Other without prop title' })).content[0]!.text).toContain('UNSUPPORTED_INTENT_FRAMEWORK');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/Child.vue'), '<template><div/></template>');
    expect((await findCodeTool.handler(args)).content[0]!.text).toContain('AMBIGUOUS_INTENT_COMPONENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('intent searches return visible query, candidate boundaries, recovery and distinct query identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-intent-'));
  try {
    await writeFile(join(root, 'Child.vue'), '<template><div /></template>');
    await writeFile(join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue"</script><template><Child title="found"/><Child v-bind="attrs"/></template>');
    const args = { path: root, format: 'json', intent: 'komponen Child yang memakai prop title' };
    const result = await findCodeTool.handler(args);
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as any;
    expect(data.interpretation.query).toEqual({ operation: 'component-prop-usages', target: join(root, 'Child.vue'), prop: 'title', scope: root });
    expect(data.matches.map((item: any) => item.resolution)).toEqual(['resolved', 'candidate']);
    expect(data.matches[0].snippet).toBe('title="found"');
    expect(data.decision.status).toBe('partial');
    expect(data.decision.capability.operation).toBe('intent');
    const different = await findCodeTool.handler({ ...args, intent: 'component Child using prop absent' });
    expect((different.structuredContent as any).retrieval.queryId).not.toBe(data.retrieval.queryId);
    await writeFile(join(root, 'Parent.vue'), '<template><div /></template>');
    const empty = await findCodeTool.handler(args);
    expect(empty.structuredContent?.matches).toEqual([]);
    expect((empty.structuredContent?.decision as any).emptyOutcome).toBe('inconclusive');
    for (const extra of [{ intent: 'change everything' }, { pattern: 'x' }, { mode: 'literal' }, { exclude_dirs: ['src'] }, { max_results: 1 }])
      expect((await findCodeTool.handler({ ...args, ...extra })).isError).toBe(true);
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'other/Child.vue'), '<template><div /></template>');
    const ambiguous = await findCodeTool.handler(args);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]!.text).toContain('AMBIGUOUS_INTENT_COMPONENT');
    expect((await findCodeTool.handler({ ...args, intent: 'component Missing using prop title' })).isError).toBe(true);
    await writeFile(join(root, 'ReactChild.tsx'), 'export function ReactChild() {}');
    const unsupported = await findCodeTool.handler({ ...args, intent: 'component ReactChild using prop title' });
    expect(unsupported.content[0]!.text).toContain('UNSUPPORTED_INTENT_FRAMEWORK');
  } finally { await rm(root, { recursive: true, force: true }); }
});
