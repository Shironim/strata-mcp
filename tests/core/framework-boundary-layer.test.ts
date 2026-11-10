import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detectFramework, detectFrameworkWithEvidence } from '../../src/engine/framework-detector';
import { extractComponentContract, extractRenderBoundary } from '../../src/engine/contract';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp('/tmp/strata-boundary-layer-');
  try { await writeFile(join(root,'package.json'),'{}'); await run(root); }
  finally { await rm(root,{recursive:true,force:true}); }
}

for (const framework of ['vue','nuxt'] as const) {
  test(`${framework}: filename and wrapper conventions require their owning framework`, async () => fixture(async root => {
    await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{[framework]:framework === 'vue' ? '3.5.13':'3.17.0'}}));
    for (const suffix of ['client','server']) {
      const path=join(root,`Card.${suffix}.vue`);
      const code='<template><ClientOnly><p/></ClientOnly></template>';
      const result=await extractComponentContract(path,code,{workspaceRoot:root,});
      expect(result.framework).toBe(framework);
      expect(result.renderBoundary?.boundary).toBe(framework === 'nuxt' ? `${suffix}-only` : 'isomorphic');
      expect(result.renderBoundary?.evidence?.resolution).toBe('candidate');
    }
    const plain=await extractComponentContract(join(root,'Card.vue'),'<template><ClientOnly><p/></ClientOnly></template>',{workspaceRoot:root,});
    expect(plain.renderBoundary?.directive).toBe(framework === 'nuxt' ? '<ClientOnly>' : undefined);
    expect(detectFramework(join(root,'composables/useCard.vue'),'<template/>',root)).toBe(framework);
  }));
}

for (const framework of ['react','next'] as const) {
  test(`${framework}: identical app path and source use ecosystem identity rather than folder alone`, async () => fixture(async root => {
    await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{[framework]:framework === 'react' ? '19.0.0':'15.0.0'}}));
    const path=join(root,'app/page.tsx');
    await mkdir(join(root,'app'));
    const code=`import {useState} from 'react'; // from 'next/link'\nexport default function Page(){useState(0);return <button onClick={()=>save()}/>}`;
    const result=await extractComponentContract(path,code,{workspaceRoot:root,});
    expect(result.framework).toBe(framework);
    expect(result.renderBoundary?.boundary).toBe(framework === 'next' ? 'server-component' : 'client-component');
    expect(result.renderBoundary?.violations?.length ?? 0).toBe(framework === 'next' ? 2 : 0);
    const shared=extractRenderBoundary(join(root,'lib/Card.tsx'),'export default ()=>null',framework);
    expect(shared.evidence?.resolution).toBe('candidate');
    if(framework === 'next') expect(shared.boundary).toBe('isomorphic');
  }));
}

for(const framework of ['astro','svelte'] as const) {
  test(`${framework}: extension ownership survives foreign ecosystem and textual directives`, async () => fixture(async root => {
    await writeFile(join(root,'package.json'),' {"dependencies":{"next":"15.0.0","nuxt":"3.17.0"}}');
    const path=join(root,`app/Card.client.${framework}`);
    const code=framework === 'astro' ? `---\nconst text="'use client'; from 'next/link'";\n---\n<p/>`
      : `<script>const text="'use client'; from 'next/link'";</script><p/>`;
    expect(detectFrameworkWithEvidence(path,code,root).framework).toBe(framework);
    const result=await extractComponentContract(path,code,{workspaceRoot:root,});
    expect(result.framework).toBe(framework);
    expect(result.renderBoundary?.boundary).toBe(framework === 'astro' ? 'astro-static' : 'unknown');
    expect(result.renderBoundary?.evidence?.resolution).toBe(framework === 'astro' ? 'candidate' : 'unresolved');
  }));
}

test('React directives identify local boundaries without inventing Next identity',async()=>fixture(async root=>{
  for(const directive of ['use client','use server']) {
    const path=join(root,'app/Card.tsx');const code=`'${directive}'; export default ()=>null`;
    const detected=detectFrameworkWithEvidence(path,code,root);
    expect(detected.framework).toBe('react');
    expect(detected.evidence.resolution).toBe('candidate');
    expect(detected.evidence.method).toBe('react-directive-convention');
    const contract=await extractComponentContract(path,code,{workspaceRoot:root,});
    expect(contract.framework).toBe('react');expect(contract.renderBoundary?.directive).toBe(directive);
  }
}));

test('framework signatures ignore comment/string/type imports and shadowed conventional calls',async()=>fixture(async root=>{
  const path=join(root,'helper.ts');
  for(const code of [
    `// import Link from 'next/link'; useFetch('/api')\nconst text="from 'vue'; useState(0)";`,
    `import type {LinkProps} from 'next/link'; import {type Ref} from 'vue';`,
    `function useFetch(x:any){return x}; useFetch('/api');`,
    `function ref(x:any){return x}; ref(0);`,
    `function useState(x:any){return x}; useState(0);`,
    `function nested(definePageMeta:any){definePageMeta({})}`,
  ]) expect(detectFrameworkWithEvidence(path,code,root).framework).toBe('unknown');
  expect(detectFrameworkWithEvidence(path,`import '#app';`,root).framework).toBe('nuxt');
  expect(detectFrameworkWithEvidence(path,`import 'next/link';`,root).framework).toBe('next');
  const macro=detectFrameworkWithEvidence(path,'definePageMeta({layout:false})',root);
  expect(macro.framework).toBe('nuxt');expect(macro.evidence.resolution).toBe('candidate');
  expect(detectFrameworkWithEvidence(path,`import React from 'react'; useFetch('/api');`,root).framework).toBe('react');
}));

test('explicit scope bounds discovery while the nearest package retains ownership',async()=>fixture(async root=>{
  const nested=join(root,'nested');await mkdir(nested);
  await writeFile(join(nested,'package.json'),'{"dependencies":{"vue":"3.5.13"}}');
  await writeFile(join(root,'package.json'),'{"dependencies":{"nuxt":"3.17.0"}}');
  const path=join(nested,'Card.client.vue');const code='<template><p/></template>';
  expect(detectFramework(path,code)).toBe('vue');
  expect(detectFramework(path,code,root)).toBe('vue');
  expect((await extractComponentContract(path,code,{workspaceRoot:root,})).renderBoundary?.boundary).toBe('isomorphic');
}));
