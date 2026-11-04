import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Tests the built Strata protocol on six isolated fixtures, not framework application runtimes.
const root = await mkdtemp('/tmp/strata-template-layer-smoke-');
await writeFile(join(root,'package.json'),'{"dependencies":{"next":"15.0.0","nuxt":"3.17.0","astro":"5.0.0"}}');
const fixtures = [
  { framework: 'vue', dependencies: { vue: '3.5.13' }, file: 'Card.client.vue', code: `<script setup>const save=()=>{};const text='<ClientOnly/>';</script><template><!-- <ClientOnly/> --><button @click.stop="save"/></template>` },
  { framework: 'nuxt', dependencies: { nuxt: '3.17.0', vue: '3.5.13' }, file: 'Card.client.vue', code: `<script setup>const save=()=>{};const text='<ClientOnly/>';</script><template><!-- <ClientOnly/> --><button @click.stop="save"/></template>` },
  { framework: 'react', dependencies: { react: '19.0.0' }, file: 'app/Card.tsx', code: `const text="from 'next/link'"; export default function Card(){return <button onClick={()=>save()}/>}` },
  { framework: 'next', dependencies: { next: '15.0.0', react: '19.0.0' }, file: 'app/page.tsx', code: `export default function Page(){return <><Client onClick={save}/><button onInputCapture={()=>save()}/></>}` },
  { framework: 'astro', dependencies: { astro: '5.0.0' }, file: 'Card.astro', code: `---\nconst save=()=>{};\n---\n<!-- <Ghost client:load/> --><Card onSave={()=>{const text='} >';save()}} client:visible/>` },
  { framework: 'svelte', dependencies: { svelte: '5.57.2' }, file: 'Card.svelte', code: `<script>const save=()=>{};const text='on:ghost={save}';</script><!-- on:fake={save} --><button on:click|preventDefault={()=>{save()}}/>` },
];
for (const fixture of fixtures) {
  const workspace = join(root,fixture.framework);
  await mkdir(join(workspace,fixture.file,'..'),{recursive:true});
  await writeFile(join(workspace,'package.json'),JSON.stringify({dependencies:fixture.dependencies}));
  await writeFile(join(workspace,fixture.file),fixture.code);
}
const proc=Bun.spawn(['bun',resolve(import.meta.dir,'../../dist/mcp.js')],{stdin:'pipe',stdout:'pipe',stderr:'ignore'});
const timeout=setTimeout(()=>proc.kill(),45000);
const reader=proc.stdout.getReader(); const decoder=new TextDecoder();let buffer='';let id=0;
async function request(method:string,params:object) {
  const callId=++id;
  proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:callId,method,params})+'\n');proc.stdin.flush();
  while(true) {
    const newline=buffer.indexOf('\n');
    if(newline>=0) {
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
      const message=JSON.parse(line);if(message.id===callId) {assert.ok(!message.error,JSON.stringify(message.error));return message.result;}
      continue;
    }
    const chunk=await reader.read();if(chunk.done)throw new Error('MCP closed before response');
    buffer+=decoder.decode(chunk.value,{stream:true});
  }
}
try {
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'template-layer-smoke',version:'1'}});
  proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');proc.stdin.flush();
  for(const fixture of fixtures) {
    const workspace=join(root,fixture.framework);
    const args={path:join(workspace,fixture.file),project_root:root,format:'json',resolve_globals:false};
    const response=await request('tools/call',{name:'inspect_component',arguments:args});
    assert.ok(!response.isError,JSON.stringify(response));
    const data=response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(data.framework,fixture.framework);
    assert.equal(data.projectContext.ownerRoot,workspace);assert.equal(data.projectContext.scopeRoot,root);
    if(fixture.framework==='vue') { assert.equal(data.renderBoundary.directive,undefined); assert.equal(data.renderBoundary.boundary,'isomorphic'); }
    if(fixture.framework==='nuxt') assert.equal(data.renderBoundary.directive,'.client.vue');
    assert.ok(data.renderBoundary.evidence);
    if(fixture.framework==='react') assert.ok(!data.renderBoundary.violations?.length);
    if(fixture.framework==='next') assert.ok(data.renderBoundary.violations.some((v:any)=>v.code==='RSC_EVENT_HANDLER_IN_SERVER_COMPONENT' && v.message.includes('onInputCapture')));
    if(fixture.framework==='astro') assert.deepEqual(data.islands.map((v:any)=>v.component),['Card']);
    if(fixture.framework==='svelte') {
      const events=data.patternDiagnostics.filter((v:any)=>v.ruleId==='svelte/prefer-callback-props-over-dispatcher');
      assert.equal(events.length,1);assert.equal(events[0].fact.snippet,'on:click|preventDefault={()=>{save()}}');
    }
    const summary=await request('tools/call',{name:'inspect_component',arguments:{...args,response_detail:'summary'}});
    assert.ok(!summary.isError);
    const brief=summary.structuredContent ?? JSON.parse(summary.content[0].text);
    assert.ok(brief.resultSummary && brief.retrieval.completeness==='partial');
    const {violations,...boundarySummary}=data.renderBoundary;
    assert.deepEqual(brief.resultSummary.contract.renderBoundary,boundarySummary);
    assert.equal(brief.resultSummary.contract.framework,fixture.framework);
    assert.equal(brief.resultSummary.contract.projectContext.ownerRoot,workspace);
    const boundaryCode=fixture.framework==='svelte'?'RENDER_BOUNDARY_UNVERIFIED':'RENDER_BOUNDARY_PARTIAL';
    if(data.renderBoundary.evidence.resolution!=='resolved') {
      assert.ok(data.retrieval.omissions.some((v:any)=>v.code===boundaryCode));
      assert.ok(brief.retrieval.omissions.some((v:any)=>v.code===boundaryCode));
      assert.equal(data.decision.status,'partial');assert.equal(brief.decision.status,'partial');
    }
    if(fixture.framework==='svelte') assert.ok(JSON.stringify(brief.safetyDetails).includes('preventDefault'));
    console.log(`PASS: ${fixture.framework} inspect full/summary through built MCP stdio`);
  }
  const workspace=join(root,'next');await mkdir(join(workspace,'features/app'),{recursive:true});
  const decoy=join(workspace,'features/app/Fake.tsx');await writeFile(decoy,'export default ()=> <button onClick={()=>save()}/>');
  const decoyResult=await request('tools/call',{name:'inspect_component',arguments:{path:decoy,project_root:root,format:'json',resolve_globals:false}});
  assert.ok(!decoyResult.isError);assert.equal(decoyResult.structuredContent.renderBoundary.boundary,'isomorphic');
  const ambiguous=await request('tools/call',{name:'audit_frontend',arguments:{path:root,target:'routes',format:'json',response_detail:'summary'}});
  assert.ok(!ambiguous.isError);
  assert.equal(ambiguous.structuredContent.resultSummary.projectContext.status,'conflict');
  assert.ok(ambiguous.structuredContent.retrieval.omissions.some((v:any)=>v.code==='PROJECT_FRAMEWORK_CONFLICT'));
  assert.equal(ambiguous.structuredContent.decision.emptyOutcome,'inconclusive');
  console.log('PASS: mixed workspace ownership, nested app decoy and ambiguous route scope');
} finally {
  clearTimeout(timeout);proc.kill();await proc.exited;await rm(root,{recursive:true,force:true});
}
