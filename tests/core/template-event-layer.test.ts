import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRenderBoundary } from '../../src/engine/contract';
import { extractAstroContract } from '../../src/engine/parsers/contract-astro';
import { auditEventHandlers } from '../../src/engine/reactivity';
import { runCanonAudit } from '../../src/engine/canon';
import { astroOpeningTags } from '../../src/engine/astro-template';
import type { FrontendFramework } from '../../src/types';

async function canon(framework: FrontendFramework, code: string, file: string, majorVersion?: number) {
  return runCanonAudit({ file, sha256: createHash('sha256').update(code).digest('hex'), encoding: 'utf-8',
    offsetUnit: 'utf16', lineCount: code.split('\n').length }, code, framework, { majorVersion });
}

for (const framework of ['vue', 'nuxt'] as const) {
  test(`${framework}: native and component event directives retain template scope and modifiers`, async () => {
    const root = await mkdtemp('/tmp/strata-event-layer-');
    const path = join(root, 'Card.vue');
    const code = `<script setup>const save=()=>{}; const text='<ClientOnly>@click="ghost"</ClientOnly>';</script>
      <template><!-- <ClientOnly><button @click="ghost"/></ClientOnly> -->
      <button @click.stop="save"/><Child @save="save"/></template>`;
    try {
      await writeFile(join(root,'package.json'), JSON.stringify({ dependencies: { [framework]: framework === 'vue' ? '3.5.13' : '3.17.0' } }));
      await writeFile(path, code);
      const result = await auditEventHandlers({ path, code });
      expect(result.totalEventBindings).toBe(2);
      expect(result.brokenHandlers).toEqual([]);
      expect(extractRenderBoundary(path, code, framework).directive).toBeUndefined();
      expect(extractRenderBoundary(path, '<template><ClientOnly><button @click="save"/></ClientOnly></template>', framework).directive).toBe(framework === 'nuxt' ? '<ClientOnly>' : undefined);
      expect(extractRenderBoundary(path, '<template><client-only><button @click="save"/></client-only></template>', framework).directive).toBe(framework === 'nuxt' ? '<ClientOnly>' : undefined);
      expect((await canon(framework, code, path)).some(item => item.ruleId === 'next/rsc-event-handler')).toBe(false);
    } finally { await rm(root, {recursive:true,force:true}); }
  });
}

for (const framework of ['react', 'next'] as const) {
  test(`${framework}: JSX host handlers and component callbacks follow framework boundary rules`, async () => {
    const path = framework === 'next' ? '/project/app/page.tsx' : '/project/src/Page.tsx';
    const code = `// onClick=ghost\nconst text='onInput=ghost'; export default function Page(){return <>
      <Client onSuccess={callback}/><input onInputCapture={handler}/></>}`;
    const rules = (await canon(framework,code,path)).filter(item => item.ruleId === 'next/rsc-event-handler');
    expect(rules).toHaveLength(framework === 'next' ? 1 : 0);
    const boundary = extractRenderBoundary(path,code,framework);
    expect(boundary.violations?.some(item => item.code === 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT') ?? false).toBe(framework === 'next');
    if (framework === 'next') expect(rules[0].fact.snippet).toBe('onInputCapture={handler}');
    expect((await canon(framework,`'use client';${code}`,path)).some(item => item.ruleId === 'next/rsc-event-handler')).toBe(false);
  });
}

test('Astro: tag boundaries preserve expressions and ignore frontmatter, comments, raw blocks and quoted decoys', async () => {
  const code = `---
const ghost='<Ghost client:load />'; const save=()=>{};
---
<!-- <Ghost client:load onClick={save}/> -->
<script>const ghost='<Ghost client:load />'</script>
{ '<Ghost client:load />' }
<Card title="client:load onClick={save}" />
<Widget onSave={(e)=> { const text='} >'; save(e) }} client:visible />`;
  const contract = await extractAstroContract('/Card.astro',code);
  expect(contract.islands?.map(item => item.component)).toEqual(['Widget']);
  expect(contract.islands?.[0].props?.onSave).toContain("const text='} >'");
  const rules = (await canon('astro',code,'/Card.astro')).filter(item => item.ruleId === 'astro/no-function-props-to-island');
  expect(rules).toHaveLength(1);
  expect(rules[0].fact.snippet).toBe('<Widget onSave={(e)=> { const text=\'} >\'; save(e) }} client:visible />');
  const boundary = extractRenderBoundary('/Card.astro',code,'astro');
  expect(boundary.boundary).toBe('astro-island');
  const decoys = code.slice(0,code.indexOf('<Widget'));
  expect(extractRenderBoundary('/Card.astro',decoys,'astro').boundary).toBe('astro-static');
  expect((await extractAstroContract('/Card.astro',decoys)).islands).toBeUndefined();
  expect((await canon('astro',`---\nconst save=()=>{};\n---\n<Card title="{save}" client:load/>`,'/Card.astro'))
    .some(item=>item.ruleId === 'astro/no-function-props-to-island')).toBe(false);
});

test('Astro: one hydrated sibling does not hide unhydrated widget candidates', () => {
  const result = extractRenderBoundary('/Card.astro','<Counter client:load/><SaveButton/>','astro');
  expect(result.isClientHydrated).toBe(true);
  expect(result.violations?.[0].message).toContain('SaveButton');
});

test('Astro: opening tag scan retains nested values and tags in conditional expressions', () => {
  const template = `{ready && <Card value={{key: '}', nested: {value: 1}}} client:load />}
    <Card value={\`hello \${other({key:'}'})}\`} client:idle/>`;
  expect(astroOpeningTags(template).map(item=>item.name)).toEqual(['Card','Card']);
});

test('Svelte: compiler AST selects full directive spans and preserves migration cautions', async () => {
  const code=`<script>const text='on:ghost={save}'; const save=()=>{};</script>
    <!-- <button on:fake={save}/> -->
    <button on:click|preventDefault={()=>{save()}}/><Child on:done/><input oninput={save}/>`;
  const rules=(await canon('svelte',code,'/Card.svelte',5)).filter(item=>item.ruleId === 'svelte/prefer-callback-props-over-dispatcher');
  expect(rules).toHaveLength(2);
  expect(rules.map(item=>item.fact.snippet)).toEqual(['on:click|preventDefault={()=>{save()}}','on:done']);
  expect(rules[0].canon.summary).toContain('preventDefault');
  expect(rules[1].canon.summary).toContain('component callback contracts');
  for (const rule of rules) expect(code.slice(rule.fact.ref!.startOffset,rule.fact.ref!.endOffset)).toBe(rule.fact.snippet);
  expect((await canon('svelte',code,'/Card.svelte',4)).some(item=>item.ruleId === 'svelte/prefer-callback-props-over-dispatcher')).toBe(false);
});

test('Svelte: malformed template cannot revive regex-only event matches', async () => {
  const rules=await canon('svelte','<script>const text="on:ghost={save}"</script><button on:click={','/Card.svelte',5);
  expect(rules.some(item=>item.ruleId === 'svelte/prefer-callback-props-over-dispatcher')).toBe(false);
});

test('Svelte: BOM and Unicode preserve exact directive source references', async () => {
  const code='\uFEFF<p>😀</p><button on:click={()=>save()}/>';
  const rules=(await canon('svelte',code,'/Card.svelte',5)).filter(item=>item.ruleId === 'svelte/prefer-callback-props-over-dispatcher');
  expect(rules).toHaveLength(1);
  expect(code.slice(rules[0].fact.ref!.startOffset,rules[0].fact.ref!.endOffset)).toBe('on:click={()=>save()}');
});
