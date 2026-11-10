import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { analyzePropImpact } from '../../src/engine/prop-impact';
import { inspectComponentTool } from '../../src/tools/inspect-component';

const props = [{ name: 'title', type: 'string', required: true }, { name: 'modelValue', type: 'string', required: false }, { name: 'unused', type: 'boolean', required: false }];

test('omission evidence distinguishes absent props from forwarding and counts render sites separately', async () => fixture(async (root, target) => {
  const file = join(root, 'Parent.vue');
  const content = '<script setup>import Child from "./Child.vue"</script><template><Child/><Child/><Child v-bind="attrs"/><Child :[key]="value"/><Child title="explicit" v-bind="attrs"/><Child v-model="value"/></template>';
  await writeFile(file, content);
  await writeFile(join(root, 'Candidate.vue'), '<template><Child/></template>');
  const result = await analyzePropImpact({ target, workspace: root, props, detail: 'full' });
  const title = result.props[0]!;
  expect(title.omittedRenderCount).toBe(3);
  expect(title.omittedConsumerCount).toBe(1);
  expect(title.indeterminateRenderCount).toBe(2);
  expect(title.omissions!.map(item => content.slice(item.sourceRef.startOffset, item.sourceRef.endOffset))).toEqual(['<Child/>', '<Child/>', '<Child v-model="value"/>']);
  expect(result.props[1]!.omittedRenderCount).toBe(2);
  expect(result.props[1]!.indeterminateRenderCount).toBe(3);
  expect(title.risk.reasons.some(reason => reason.includes('requiredness and default'))).toBe(true);
  const summary = await analyzePropImpact({ target, workspace: root, props, detail: 'summary' });
  expect(summary.props[0]!.omittedRenderCount).toBe(3);
  expect(summary.props[0]!.omissions).toBeUndefined();
  const response = await inspectComponentTool.handler({ path: target, project_root: root, impact: 'full', response_detail: 'summary', format: 'json' });
  const projected = (response.structuredContent as any).propImpact.props[0];
  expect(projected.omittedRenderCount).toBe(3);
  expect(projected.omissions).toBeUndefined();
  expect(projected.usages).toBeUndefined();
}));
async function fixture(run: (root: string, target: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'strata-prop-impact-'));
  try {
    const target = join(root, 'Child.vue');
    await writeFile(target, '<script setup lang="ts">defineProps<{ title: string; modelValue?: string; unused?: boolean }>()</script><template><div /></template>');
    await run(root, target);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('counts unique consumers separately from usages, with exact Unicode/CRLF source refs and import-only controls', async () => fixture(async (root, target) => {
  const file = join(root, 'Parent.vue');
  const content = '<script setup>import Alias from "./Child.vue"</script>\r\n<template><!-- 🙂 <Alias title="decoy"/> -->\r\n<Alias title="one"/><Alias :title="two" v-model="value"/></template>';
  await writeFile(file, content);
  await writeFile(join(root, 'ImportOnly.vue'), '<script setup>import Child from "./Child.vue"</script><template><div /></template>');
  await mkdir(join(root, 'other'));
  await writeFile(join(root, 'other/Child.vue'), '<template><div /></template>');
  await writeFile(join(root, 'Other.vue'), '<script setup>import Child from "./other/Child.vue"</script><template><Child title="unrelated"/></template>');
  const result = await analyzePropImpact({ target, workspace: root, props, detail: 'full' });
  const title = result.props.find(prop => prop.name === 'title')!;
  expect(title.confirmedConsumerCount).toBe(1);
  expect(title.confirmedUsageCount).toBe(2);
  expect(title.candidateConsumerCount).toBe(0);
  expect(result.props.find(prop => prop.name === 'modelValue')!.confirmedUsageCount).toBe(1);
  expect(result.props.find(prop => prop.name === 'unused')!.risk.renameOrRemove).toBe('unknown');
  expect(result.renderConsumerCount).toBe(1);
  expect(result.unknownConsumerCount).toBeNull();
  expect(title.usages!.map(usage => content.slice(usage.sourceRef.startOffset, usage.sourceRef.endOffset))).toEqual(['title="one"', ':title="two"']);
  for (const usage of title.usages!) expect(usage.sourceRef.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  const summary = await analyzePropImpact({ target, workspace: root, props, detail: 'summary' });
  expect(summary.props[0]!.usages).toBeUndefined();
  expect(summary.inputIdentity).toBe(result.inputIdentity);
  expect(summary.props[0]!.confirmedUsageCount).toBe(2);
  expect(await access(join(root, '.strata')).then(() => true, () => false)).toBe(false);
}));

test('forwarding, dynamic selectors, auto-import candidates, scope bindings and unsupported sources keep risks open', async () => fixture(async (root, target) => {
  await writeFile(join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue"</script><template><Child v-bind="attrs" :[key]="value"/><component :is="selected" title="maybe"/><Child v-for="Child in items" title="shadowed"/></template>');
  await writeFile(join(root, 'Auto.vue'), '<template><Child title="candidate" /></template>');
  await writeFile(join(root, 'Options.vue'), '<script>import Child from "./Child.vue"; export default {}</script><template><Child title="registration-unknown" /></template>');
  await writeFile(join(root, 'Unsupported.vue'), '<template lang="pug">Child(title="x")</template>');
  await writeFile(join(root, 'Broken.vue'), '<template><Child></template>');
  await writeFile(join(root, 'render.tsx'), 'export const Render = () => <Child title="outside-capability"/>;');
  const result = await analyzePropImpact({ target, workspace: root, props, detail: 'full' });
  const title = result.props[0]!;
  expect(title.confirmedUsageCount).toBe(0);
  expect(title.candidateConsumerCount).toBe(3);
  expect(title.candidateUsageCount).toBe(6);
  expect(title.risk.renameOrRemove).toBe('unknown');
  expect(result.status).toBe('partial');
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['PROP_IMPACT_CANDIDATE', 'VUE_TEMPLATE_UNSUPPORTED', 'VUE_PARSE_FAILED', 'PROP_IMPACT_UNSCANNED']));
}));

test('alias/barrel imports resolve to the explicit target; filtered scope does not imply workspace-wide absence', async () => fixture(async (root, target) => {
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
  await writeFile(join(root, 'index.ts'), 'export { default as Child } from "./Child.vue";');
  await mkdir(join(root, 'feature'));
  await writeFile(join(root, 'feature/Parent.vue'), '<script setup>import { Child as Alias } from "@/index"</script><template><Alias title="yes"/></template>');
  const result = await analyzePropImpact({ target, workspace: root, props, detail: 'full' });
  expect(result.props[0]!.confirmedConsumerCount).toBe(1);
  await mkdir(join(root, 'empty'));
  const empty = await analyzePropImpact({ target, workspace: join(root, 'empty'), props, detail: 'summary' });
  expect(empty.props[0]!.confirmedConsumerCount).toBe(0);
  expect(empty.props[0]!.risk.renameOrRemove).toBe('unknown');
  expect(empty.scope).toBe(join(root, 'empty'));
  expect(empty.unknownConsumerCount).toBeNull();
}));

test('real inspect handler exposes opt-in impact in text/JSON without changing default contract or accepting selector conflicts', async () => fixture(async (root, target) => {
  await writeFile(join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue"</script><template><Child title="yes"/></template>');
  const base = { path: target, project_root: root, };
  const defaultResult = await inspectComponentTool.handler({ ...base, format: 'json' });
  expect(defaultResult.isError).not.toBe(true);
  expect(defaultResult.structuredContent?.propImpact).toBeUndefined();
  for (const format of ['json', 'text']) {
    const result = await inspectComponentTool.handler({ ...base, impact: 'full', format });
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as any;
    expect(data.propImpact.props.find((prop: any) => prop.name === 'title').confirmedConsumerCount).toBe(1);
    expect(data.retrieval.omissions.some((item: any) => item.code === 'PROP_IMPACT_PARTIAL')).toBe(true);
    expect(data.decision.status).toBe('partial');
    if (format === 'json') expect(JSON.parse(result.content[0]!.text).propImpact).toEqual(data.propImpact);
    else expect(result.content[0]!.text).toContain('1 confirmed consumers');
    const usage = data.propImpact.props[0].usages[0];
    const source = await readFile(usage.file, 'utf8');
    expect(source.slice(usage.sourceRef.startOffset, usage.sourceRef.endOffset)).toBe('title="yes"');
  }
  for (const extra of [{ impact: true }, { impact: 'full', view: 'map' }, { impact: 'full', symbol: 'x' }])
    expect((await inspectComponentTool.handler({ ...base, ...extra })).isError).toBe(true);
}));

test('Workstream 4: analyzes prop impact on React TSX files with explicit, spread, and omitted renders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-prop-impact-tsx-'));
  try {
    const target = join(root, 'Button.tsx');
    await writeFile(
      target,
      'import React from "react";\nexport interface ButtonProps { label: string; disabled?: boolean; }\nexport function Button({ label, disabled }: ButtonProps) { return <button disabled={disabled}>{label}</button>; }\n'
    );

    const consumer = join(root, 'App.tsx');
    const consumerContent = `
import React from 'react';
import { Button } from './Button';

export function App(props: any) {
  return (
    <div>
      <Button label="Click Me" />
      <Button label="Submit" disabled={true} />
      <Button {...props} />
      <Button />
    </div>
  );
}
`;
    await writeFile(consumer, consumerContent);

    const result = await analyzePropImpact({
      target,
      workspace: root,
      props: [
        { name: 'label', type: 'string', required: true },
        { name: 'disabled', type: 'boolean', required: false },
      ],
      detail: 'full',
    });

    expect(result.status).toBe('partial');
    const labelProp = result.props.find((p) => p.name === 'label')!;
    expect(labelProp).toBeDefined();

    // 2 explicit renders: <Button label="Click Me" />, <Button label="Submit" />
    expect(labelProp.confirmedUsageCount).toBe(2);
    expect(labelProp.confirmedConsumerCount).toBe(1);

    // 1 spread render: <Button {...props} /> -> candidate usage + indeterminate supply
    expect(labelProp.candidateUsageCount).toBe(1);
    expect(labelProp.indeterminateRenderCount).toBe(1);

    // 1 omitted render: <Button /> without label or spread
    expect(labelProp.omittedRenderCount).toBe(1);
    expect(labelProp.omissions?.length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
