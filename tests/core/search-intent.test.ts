import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseComponentPropQuery } from '../../src/engine/search-intent';
import { findCodeTool } from '../../src/tools/find-code';

test('structured component-prop query validates component, prop_name, and prop_presence', () => {
  expect(parseComponentPropQuery({ component: 'Child', prop: 'title' })).toEqual({
    component: 'Child',
    prop: 'title',
    presence: 'present',
    operation: 'component-prop-usages',
  });
  expect(parseComponentPropQuery({ component: 'Child', prop: 'title', presence: 'present' })).toEqual({
    component: 'Child',
    prop: 'title',
    presence: 'present',
    operation: 'component-prop-usages',
  });
  expect(parseComponentPropQuery({ component: 'Child', prop: 'title', presence: 'omitted' })).toEqual({
    component: 'Child',
    prop: 'title',
    presence: 'omitted',
    operation: 'component-prop-omissions',
  });
  for (const invalid of [
    { component: '', prop: 'title' },
    { component: 'Child', prop: '' },
    { component: 7, prop: 'title' },
    { component: 'Child', prop: 'title and count' },
  ]) {
    expect(() => parseComponentPropQuery(invalid)).toThrow('INVALID_COMPONENT_PROP_QUERY');
  }
  expect(() => parseComponentPropQuery({ component: 'Child', prop: 'title', presence: 'maybe' })).toThrow('INVALID_PROP_PRESENCE');
});

test('prop_presence omitted returns exact resolved render refs, preserves uncertainty and never treats forwarding as absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-prop-omission-'));
  try {
    await writeFile(join(root, 'Child.vue'), '<script setup>defineProps({ title: String })</script><template><div/></template>');
    const source = '<script setup>import Alias from "./Child.vue"</script>\r\n<template><!-- 🙂 --><Alias/><Alias title="yes"/><Alias v-bind="attrs"/><Alias :[key]="value"/><Alias v-model:[model]="value"/><Alias v-for="Alias in list"/><component :is="selected"/></template>';
    await writeFile(join(root, 'Parent.vue'), source);
    await writeFile(join(root, 'Candidate.vue'), '<template><Child/></template>');
    const args = { path: root, format: 'json', component: 'Child', prop_name: 'title', prop_presence: 'omitted' };
    const response = await findCodeTool.handler(args);
    expect(response.isError).not.toBe(true);
    const data = response.structuredContent as any;
    expect(data.query.operation).toBe('component-prop-omissions');
    expect(data.query.presence).toBe('omitted');
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ snippet: '<Alias/>', resolution: 'resolved', line: 2 });
    const ref = data.matches[0].sourceRef;
    expect(source.slice(ref.startOffset, ref.endOffset)).toBe('<Alias/>');
    expect(ref.sha256).toBe(new Bun.CryptoHasher('sha256').update(source).digest('hex'));
    expect(data.coverage.propSupply).toMatchObject({ omittedRenderCount: 1, omittedConsumerCount: 1, indeterminateRenderCount: 3 });
    expect(data.decision.status).toBe('partial');
    const usage = await findCodeTool.handler({ ...args, prop_presence: 'present' });
    expect((usage.structuredContent as any).retrieval.queryId).not.toBe(data.retrieval.queryId);
    const summary = await findCodeTool.handler({ ...args, response_detail: 'summary' });
    expect((summary.structuredContent as any).query).toEqual(data.query);
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
      expect((await findCodeTool.handler({ ...args, ...extra })).content[0]!.text).toContain('PROP_SELECTOR_CONFLICT');
    expect((await findCodeTool.handler({ ...args, path: join(root, 'Child.vue') })).content[0]!.text).toContain('INVALID_PROP_SEARCH_SCOPE');
    expect((await findCodeTool.handler({ ...args, component: 'Missing' })).content[0]!.text).toContain('PROP_COMPONENT_NOT_FOUND');
    await writeFile(join(root, 'Other.svelte'), '<script>export let prop;</script>');
    expect((await findCodeTool.handler({ ...args, component: 'Other' })).content[0]!.text).toContain('UNSUPPORTED_PROP_SEARCH_FRAMEWORK');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/Child.vue'), '<template><div/></template>');
    expect((await findCodeTool.handler(args)).content[0]!.text).toContain('AMBIGUOUS_PROP_COMPONENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('component + prop_name searches return visible query, candidate boundaries, recovery and distinct query identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-prop-search-'));
  try {
    await writeFile(join(root, 'Child.vue'), '<template><div /></template>');
    await writeFile(join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue"</script><template><Child title="found"/><Child v-bind="attrs"/></template>');
    const args = { path: root, format: 'json', component: 'Child', prop_name: 'title' };
    const result = await findCodeTool.handler(args);
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as any;
    expect(data.query).toEqual({ operation: 'component-prop-usages', target: join(root, 'Child.vue'), component: 'Child', prop: 'title', presence: 'present', scope: root });
    expect(data.matches.map((item: any) => item.resolution)).toEqual(['resolved', 'candidate']);
    expect(data.matches[0].snippet).toBe('title="found"');
    expect(data.decision.status).toBe('partial');
    expect(data.decision.capability.operation).toBe('component-prop');
    const different = await findCodeTool.handler({ ...args, prop_name: 'absent' });
    expect((different.structuredContent as any).retrieval.queryId).not.toBe(data.retrieval.queryId);
    await writeFile(join(root, 'Parent.vue'), '<template><div /></template>');
    const empty = await findCodeTool.handler(args);
    expect(empty.structuredContent?.matches).toEqual([]);
    expect((empty.structuredContent?.decision as any).emptyOutcome).toBe('inconclusive');
    for (const extra of [{ prop_name: '' }, { pattern: 'x' }, { mode: 'literal' }, { exclude_dirs: ['src'] }, { max_results: 1 }])
      expect((await findCodeTool.handler({ ...args, ...extra })).isError).toBe(true);
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'other/Child.vue'), '<template><div /></template>');
    const ambiguous = await findCodeTool.handler(args);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]!.text).toContain('AMBIGUOUS_PROP_COMPONENT');
    expect((await findCodeTool.handler({ ...args, component: 'Missing' })).isError).toBe(true);
    await writeFile(join(root, 'AstroChild.astro'), '--- ---');
    const unsupported = await findCodeTool.handler({ ...args, component: 'AstroChild' });
    expect(unsupported.content[0]!.text).toContain('UNSUPPORTED_PROP_SEARCH_FRAMEWORK');

    // React TSX component prop search support
    await writeFile(join(root, 'ReactChild.tsx'), 'export function ReactChild(props: { title: string }) { return <div>{props.title}</div>; }');
    await writeFile(join(root, 'ReactParent.tsx'), 'import { ReactChild } from "./ReactChild"; export function Parent() { return <ReactChild title="tsx-prop" />; }');
    const tsxResponse = await findCodeTool.handler({ path: root, format: 'json', component: 'ReactChild', prop_name: 'title' });
    expect(tsxResponse.isError).not.toBe(true);
    expect((tsxResponse.structuredContent as any).matches.length).toBe(1);
    expect((tsxResponse.structuredContent as any).matches[0].snippet).toBe('title="tsx-prop"');
  } finally { await rm(root, { recursive: true, force: true }); }
});
