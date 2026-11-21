import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectOwnership } from '../../src/engine/project-ownership';
import { detectFrameworkWithEvidence } from '../../src/engine/framework-detector';
import { extractComponentContract } from '../../src/engine/contract';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { batchParser, syncWorkspace } from '../../src/engine/storage/delta-sync';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { getComponentTree } from '../../src/engine/tree';
import { scanRoutes } from '../../src/engine/routes';
import { auditFrontendTool } from '../../src/tools/audit-frontend';

async function fixture(run:(root:string)=>Promise<void>) {
  const root=await mkdtemp('/tmp/strata-ownership-');
  try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
async function put(root:string,path:string,content:string) {
  const file=join(root,path);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,content);return file;
}

test('Next App Router page role agrees across routes, source traversal, and SQLite', async () => fixture(async root => {
  const appA = join(root, 'apps/a');
  const appB = join(root, 'apps/b');
  const code = 'export default function Page() { return null; }';
  for (const app of [appA, appB]) await put(app, 'package.json', '{"dependencies":{"next":"15"}}');
  const page = await put(appA, 'src/app/page.ts', code);
  const helper = await put(appA, 'src/app/page.helpers.ts', code);
  const wrongRoot = await put(appA, 'features/app/page.tsx', code);
  const otherApp = await put(appB, 'app/item/page.ts', code);
  const files = [page, helper, wrongRoot, otherApp];

  const readTreeRoles = async (direction: 'upward' | 'downward') => Promise.all(files.map(async entryPath =>
    (await getComponentTree({ entryPath, targetPath: root, direction, skipSync: true })).root.isPage));
  const initial = [true, false, false, true];
  expect((await scanRoutes({ targetPath: appA })).routes.map(({ path, filePath }) => [path, filePath])).toEqual([['/', page]]);
  expect((await scanRoutes({ targetPath: appB })).routes.map(({ path, filePath }) => [path, filePath])).toEqual([['/item', otherApp]]);
  expect(await readTreeRoles('downward')).toEqual(initial);
  expect(await readTreeRoles('upward')).toEqual(initial);

  const db = getWorkspaceDatabase(root, { create: true });
  try {
    await syncWorkspace(root);
    expect(await readTreeRoles('upward')).toEqual(initial);
    const rows = files.map(file => db.query('SELECT is_page FROM files WHERE path = ?').get(file));
    expect(rows).toEqual(initial.map(isPage => ({ is_page: Number(isPage) })));

    // The empty root app directory takes precedence over src/app without editing any source bytes.
    await mkdir(join(appA, 'app'));
    expect((await scanRoutes({ targetPath: appA })).routes).toEqual([]);
    await syncWorkspace(root);
    expect(await readTreeRoles('downward')).toEqual([false, false, false, true]);
    expect(await readTreeRoles('upward')).toEqual([false, false, false, true]);

    await rm(join(appA, 'app'), { recursive: true });
    await syncWorkspace(root);
    expect(await readTreeRoles('upward')).toEqual(initial);
  } finally {
    closeWorkspaceDatabase(root);
  }

  const scopedRoot = join(appA, 'src');
  const scopedDb = getWorkspaceDatabase(scopedRoot, { create: true });
  try {
    await syncWorkspace(scopedRoot);
    expect(scopedDb.query('SELECT is_page FROM files WHERE path = ?').get(page)).toEqual({ is_page: 1 });
    await mkdir(join(appA, 'app'));
    await syncWorkspace(scopedRoot);
    expect(scopedDb.query('SELECT is_page FROM files WHERE path = ?').get(page)).toEqual({ is_page: 0 });
  } finally {
    closeWorkspaceDatabase(scopedRoot);
  }
}));

const samples=[
  {fw:'vue',file:'Card.client.vue',code:'<template><ClientOnly/></template>',deps:{vue:'3.5.13'},boundary:'isomorphic'},
  {fw:'nuxt',file:'Card.client.vue',code:'<template><p/></template>',deps:{nuxt:'3.17.0'},boundary:'client-only'},
  {fw:'react',file:'app/Card.tsx',code:'export default ()=> <button onClick={()=>save()}/>',deps:{react:'19.0.0'},boundary:'client-component'},
  {fw:'next',file:'src/app/page.tsx',code:'export default ()=> <button onClick={()=>save()}/>',deps:{next:'15.0.0'},boundary:'server-component'},
  {fw:'astro',file:'Card.astro',code:'<Card client:visible/>',deps:{astro:'5.0.0'},boundary:'astro-island'},
  {fw:'svelte',file:'Card.svelte',code:'<p/>',deps:{svelte:'5.57.2'},boundary:'unknown'},
];
for(const sample of samples) test(`${sample.fw}: nearest child package owns source inside mixed workspace scope`,async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0","nuxt":"3.17.0","astro":"5.0.0"}}');
  const owner=join(root,'packages',sample.fw);
  await put(owner,'package.json',JSON.stringify({dependencies:sample.deps}));
  const path=await put(owner,sample.file,sample.code);
  await put(owner,'src/tsconfig.json','{}');
  const result=await inspectComponentTool.handler({path,project_root:root,format:'json',});
  expect(result.isError).not.toBe(true);const data=result.structuredContent as any;
  expect(data.framework).toBe(sample.fw);expect(data.projectContext.ownerRoot).toBe(owner);
  expect(data.projectContext.scopeRoot).toBe(root);expect(data.projectContext.status).toBe('owned');
  expect(data.renderBoundary.boundary).toBe(sample.boundary);
  expect(data.dependencies.some((input:any)=>input.path===join(owner,'package.json') && /^[a-f0-9]{64}$/.test(input.hash))).toBe(true);
  expect(data.dependencies.some((input:any)=>input.path===join(root,'package.json'))).toBe(false);
  const summary=await inspectComponentTool.handler({path,project_root:root,format:'json',response_detail:'summary'});
  expect(summary.isError).not.toBe(true);
  expect((summary.structuredContent as any).resultSummary.contract.projectContext.ownerRoot).toBe(owner);
}));

for(const sample of samples) test(`${sample.fw}: route discovery stays within the selected application owner`,async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0","nuxt":"3.17.0"}}');
  const owner=join(root,'packages',sample.fw);
  await put(owner,'package.json',JSON.stringify({dependencies:sample.deps}));
  const path=await put(owner,sample.file,sample.code);
  if(sample.fw==='vue') {
    await put(owner,'src/views/Home.vue','<template><p/></template>');
    await put(owner,'src/router/index.ts',`import Home from '../views/Home.vue';export default createRouter({routes:[{path:'/',component:Home}]})`);
  }
  if(sample.fw==='nuxt') await put(owner,'pages/index.vue','<template/>');
  if(sample.fw==='astro') await put(owner,'src/pages/index.astro','<p/>');
  if(sample.fw==='svelte') await put(owner,'src/routes/+page.svelte','<p/>');
  const result=await scanRoutes({targetPath:owner});
  const framework={vue:'vue-router',nuxt:'nuxt',react:'unknown',next:'next-app',astro:'astro',svelte:'sveltekit'}[sample.fw];
  expect(result.framework).toBe(framework);
  expect(result.projectContext?.ownerRoot).toBe(owner);
  expect(result.routes.every(route=>route.filePath.startsWith(owner+'/'))).toBe(true);
  if(sample.fw==='react') {
    expect(result.routes).toEqual([]);
    expect(result.projectContext?.diagnostics.some(item=>item.code==='ROUTE_FRAMEWORK_UNVERIFIED')).toBe(true);
  } else expect(result.routes.length).toBeGreaterThan(0);
}));

test('Next app ownership excludes arbitrary nested app paths and follows root/src precedence',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0"}}');
  const code='export default ()=> <button onClick={()=>save()}/>';
  const src=await put(root,'src/app/page.tsx',code);
  const fake=await put(root,'features/app/page.tsx',code);
  let contract=await extractComponentContract(src,undefined,{workspaceRoot:root,});
  expect(contract.projectContext?.appRoot).toBe(join(root,'src/app'));
  expect(contract.renderBoundary?.boundary).toBe('server-component');
  const outside=await extractComponentContract(fake,undefined,{workspaceRoot:root,});
  expect(outside.renderBoundary?.boundary).toBe('isomorphic');
  const real=await put(root,'app/page.tsx',code);
  contract=await extractComponentContract(src,undefined,{workspaceRoot:root,});
  expect(contract.projectContext?.appRoot).toBe(join(root,'app'));
  expect(contract.renderBoundary?.boundary).toBe('isomorphic');
  expect((await extractComponentContract(real,undefined,{workspaceRoot:root,})).renderBoundary?.boundary).toBe('server-component');
  const batch=await batchParser([fake,real],root,new Map(),false);
  expect(batch.files.get(fake)?.boundary.boundary).toBe('isomorphic');
  expect(batch.files.get(real)?.boundary.boundary).toBe('server-component');
}));

test('one local framework config disambiguates mixed dependencies without executing config',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0","nuxt":"3.17.0","astro":"5.0.0","vue":"3.5.13"}}');
  await put(root,'astro.config.mjs','throw new Error("MUST_NOT_EXECUTE");');
  const path=await put(root,'Card.client.vue','<template><p/></template>');
  const result=await extractComponentContract(path,undefined,{workspaceRoot:root,});
  expect(result.framework).toBe('vue');expect(result.projectContext?.applicationFramework).toBe('astro');
  expect(result.projectContext?.configFiles).toEqual([join(root,'astro.config.mjs')]);
  expect(result.renderBoundary?.boundary).toBe('isomorphic');
  const previous=result.dependencies!.find(item=>item.path.endsWith('astro.config.mjs'))!.hash;
  await put(root,'astro.config.mjs','export default {};');
  expect((await extractComponentContract(path,undefined,{workspaceRoot:root,})).dependencies!
    .find(item=>item.path.endsWith('astro.config.mjs'))!.hash).not.toBe(previous);
}));

test('conflicting local configs expose omissions and never select an app convention',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0","nuxt":"3.17.0"}}');
  await put(root,'next.config.js','module.exports={}');await put(root,'nuxt.config.ts','export default {}');
  const path=await put(root,'app/page.tsx',`import Link from 'next/link';export default ()=> <button onClick={()=>save()}/>`);
  const result=await inspectComponentTool.handler({path,project_root:root,format:'json',});
  const data=result.structuredContent as any;expect(result.isError).not.toBe(true);
  expect(data.projectContext.status).toBe('conflict');expect(data.projectContext.appRoot).toBeNull();
  expect(data.renderBoundary.boundary).toBe('isomorphic');
  expect(data.retrieval.omissions.some((item:any)=>item.code==='PROJECT_FRAMEWORK_CONFLICT')).toBe(true);
  expect(data.decision.status).toBe('partial');
  const routes=await auditFrontendTool.handler({path:root,target:'routes',format:'json',response_detail:'summary'});
  expect(routes.isError).not.toBe(true);
  const brief=routes.structuredContent as any;
  expect(brief.resultSummary.projectContext.status).toBe('conflict');
  expect(brief.retrieval.omissions.some((item:any)=>item.code==='PROJECT_FRAMEWORK_CONFLICT')).toBe(true);
  expect(brief.decision.emptyOutcome).toBe('inconclusive');
}));

test('route collection excludes nested package owners inside a parent app directory',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0"}}');
  await put(root,'app/page.tsx','export default ()=>null');
  await put(root,'app/embedded/package.json','{"dependencies":{"react":"19.0.0"}}');
  const nested=await put(root,'app/embedded/page.tsx','export default ()=>null');
  const result=await scanRoutes({targetPath:root});
  expect(result.routes.some(route=>route.filePath===nested)).toBe(false);
  expect(result.projectContext?.diagnostics.some(item=>item.code==='NESTED_ROUTE_OWNERS_EXCLUDED')).toBe(true);
}));

test('nested package without framework does not inherit parent Next or Nuxt identity',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0","nuxt":"3.17.0"}}');
  await put(root,'next.config.js','module.exports={}');
  await put(root,'packages/plain/package.json','{}');
  const path=await put(root,'packages/plain/app/Card.tsx','export default ()=>null');
  const detection=detectFrameworkWithEvidence(path,undefined,root);
  expect(detection.framework).toBe('react');expect(detection.evidence.resolution).toBe('candidate');
  expect(detection.projectContext?.ownerRoot).toBe(join(root,'packages/plain'));
}));

test('config-only owner survives nearby tsconfig while corrupted manifest blocks ancestor inheritance',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"next":"15.0.0"}}');
  await put(root,'apps/nuxt/nuxt.config.mjs','export default {}');
  await put(root,'apps/nuxt/src/tsconfig.json','{}');
  const path=await put(root,'apps/nuxt/src/Card.client.vue','<template/>');
  expect(detectFrameworkWithEvidence(path,undefined,root).framework).toBe('nuxt');
  for (const invalid of ['{ invalid','[]','{"dependencies":{"next":15}}']) {
    await put(root,'apps/nuxt/package.json',invalid);
    const result=detectFrameworkWithEvidence(path,undefined,root);
    expect(result.framework).toBe('vue');expect(result.projectContext?.status).toBe('unverified');
    expect(result.projectContext?.diagnostics.some(item=>item.code==='PROJECT_OWNER_MANIFEST_INVALID')).toBe(true);
  }
}));

test('physical paths outside scope and sibling-prefix paths do not inherit ownership',async()=>fixture(async root=>{
  await put(root,'scope/package.json','{"dependencies":{"next":"15.0.0"}}');
  const outside=await put(root,'scope-other/Card.tsx','export default ()=>null');
  expect(resolveProjectOwnership(outside,join(root,'scope')).status).toBe('outside-scope');
  const alias=join(root,'scope/alias');await symlink(join(root,'scope-other'),alias,'dir');
  expect(resolveProjectOwnership(join(alias,'Card.tsx'),join(root,'scope')).status).toBe('outside-scope');
}));

test('selecting a source subdirectory preserves its ancestor application owner and marks external inputs',async()=>fixture(async root=>{
  await put(root,'package.json','{"dependencies":{"nuxt":"3.17.0"}}');
  const path=await put(root,'src/Card.client.vue','<template/>');
  const result=await extractComponentContract(path,undefined,{workspaceRoot:join(root,'src'),});
  expect(result.framework).toBe('nuxt');expect(result.projectContext?.ownerRoot).toBe(root);
  expect(result.projectContext?.scopeRoot).toBe(join(root,'src'));
  expect(result.dependencies?.find(input=>input.path===join(root,'package.json'))?.isExternal).toBe(true);
}));
