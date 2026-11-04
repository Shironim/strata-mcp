import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { withDecisionResponse } from '../../src/tools/decision-response';
import { withRetrievalEvidence } from '../../src/tools/retrieval-response';
import { renderBoundaryOmission } from '../../src/tools/boundary-evidence';
import { sourceRetrievalEvidence } from '../../src/engine/retrieval-evidence';
import { readSourceSnapshot } from '../../src/engine/source-file';
import { measureResponseBytes } from '../../src/engine/context-budget';
import type { RenderBoundaryInfo } from '../../src/types';

const samples = [
  { framework:'vue', file:'Card.vue', code:'<template><p/></template>', dependencies:{vue:'3.5.13'} },
  { framework:'nuxt', file:'Card.client.vue', code:'<template><p/></template>', dependencies:{nuxt:'3.17.0'} },
  { framework:'react', file:'app/Card.tsx', code:'export default ()=> <p/>', dependencies:{react:'19.0.0'} },
  { framework:'next', file:'lib/Card.tsx', code:'export default ()=> <p/>', dependencies:{next:'15.0.0'} },
  { framework:'astro', file:'Card.astro', code:'<Card client:visible/>', dependencies:{astro:'5.0.0'} },
  { framework:'svelte', file:'Card.svelte', code:'<p/>', dependencies:{svelte:'5.57.2'} },
];
for(const sample of samples) {
  test(`${sample.framework}: full JSON/text and summary retain boundary uncertainty and decision`,async()=>{
    const root=await mkdtemp('/tmp/strata-boundary-evidence-');
    try {
      const path=join(root,sample.file);await mkdir(join(path,'..'),{recursive:true});
      await writeFile(join(root,'package.json'),JSON.stringify({dependencies:sample.dependencies}));
      await writeFile(path,sample.code);
      const args={path,project_root:root,format:'json',resolve_globals:false};
      const full=await inspectComponentTool.handler(args);expect(full.isError).not.toBe(true);
      const data=full.structuredContent as any;
      expect(data.framework).toBe(sample.framework);
      const code=sample.framework==='svelte'?'RENDER_BOUNDARY_UNVERIFIED':'RENDER_BOUNDARY_PARTIAL';
      const omission=data.retrieval.omissions.find((item:any)=>item.code===code);
      expect(omission.reason).toContain(data.renderBoundary.evidence.reason);
      expect(data.decision.status).toBe('partial');
      const summary=await inspectComponentTool.handler({...args,response_detail:'summary',max_bytes:24000});
      expect(summary.isError).not.toBe(true);
      const brief=summary.structuredContent as any;
      const {violations,...expected}=data.renderBoundary;
      expect(brief.resultSummary.contract.framework).toBe(sample.framework);
      expect(brief.resultSummary.contract.renderBoundary).toEqual(expected);
      expect(brief.retrieval.omissions).toContainEqual(omission);
      expect(brief.decision.status).toBe('partial');
      expect(brief.decision.next[0].action).toBe('request-detail');
      expect(JSON.parse(summary.content[0]!.text).resultSummary.contract.renderBoundary).toEqual(expected);
      expect(measureResponseBytes(summary)).toBeLessThanOrEqual(24000);
      const text=await inspectComponentTool.handler({...args,format:'text'});
      expect(text.content[0]!.text).toContain(`Boundary evidence: ${data.renderBoundary.evidence.basis}/${data.renderBoundary.evidence.resolution}`);
      expect(text.content[0]!.text).toContain(data.renderBoundary.evidence.reason);
      expect((text.structuredContent as any).retrieval.omissions).toContainEqual(omission);
    } finally {await rm(root,{recursive:true,force:true});}
  });
}

test('resolved local directive evidence is not downgraded and exact source views do not invent boundaries',async()=>{
  const root=await mkdtemp('/tmp/strata-boundary-source-');
  try {
    const path=join(root,'Card.tsx');await writeFile(join(root,'package.json'),'{"dependencies":{"react":"19.0.0"}}');
    await writeFile(path,"'use client'; export default ()=> <p/>");
    for(const extra of [{},{response_detail:'summary'},{source_range:{start_line:1,end_line:1}}]) {
      const result=await inspectComponentTool.handler({path,project_root:root,format:'json',resolve_globals:false,...extra});
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as any).retrieval.omissions.some((item:any)=>item.code.startsWith('RENDER_BOUNDARY_'))).toBe(false);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('decision guards candidate, unresolved and missing evidence even with nominally complete retrieval',async()=>{
  const {snapshot}=await readSourceSnapshot(import.meta.path);
  const retrieval=await sourceRetrievalEvidence({workspace:import.meta.dir,snapshot,policy:'test',query:{},complete:true,selectionReason:'test'});
  const boundaries:RenderBoundaryInfo[]=[
    {boundary:'isomorphic',isClientHydrated:true,evidence:{basis:'derived',resolution:'candidate',method:'test',reason:'Caller unknown'}},
    {boundary:'unknown',isClientHydrated:false,evidence:{basis:'heuristic',resolution:'unresolved',method:'test',reason:'SSR unknown'}},
    {boundary:'client-component',isClientHydrated:true},
  ];
  for(const boundary of boundaries) for(const summary of [false,true]) {
    const data=summary?{resultSummary:{contract:{renderBoundary:boundary}}}:{renderBoundary:boundary};
    const result=withDecisionResponse({content:[],structuredContent:{...data,retrieval}},'inspect_component',{});
    expect((result.structuredContent?.decision as any).status).toBe('partial');
    const stale=withDecisionResponse({content:[],structuredContent:{...data,retrieval:{...retrieval,freshness:'stale'}}},'inspect_component',{});
    expect((stale.structuredContent?.decision as any).status).toBe('stale');
  }
  expect(renderBoundaryOmission()).toBeUndefined();
  expect(renderBoundaryOmission({boundary:'client-component',isClientHydrated:true,evidence:{basis:'source',resolution:'resolved',method:'directive-node'}})).toBeUndefined();
});

test('oversized mandatory boundary reasons fail within budget rather than silently losing uncertainty',async()=>{
  const tool=withRetrievalEvidence({name:'inspect_component',description:'',inputSchema:{type:'object'},handler:async()=>({content:[],structuredContent:{
    props:[],framework:'svelte',renderBoundary:{boundary:'unknown',isClientHydrated:false,evidence:{basis:'heuristic',resolution:'unresolved',method:'test',reason:'🙂'.repeat(20000)}}}})});
  const result=await tool.handler({path:'/fixture/Card.svelte',response_detail:'summary',max_bytes:16000});
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('BUDGET_METADATA_TOO_LARGE');
  expect(measureResponseBytes(result)).toBeLessThanOrEqual(16000);
});
