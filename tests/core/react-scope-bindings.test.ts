import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { extractComponentContextNodes } from '../../src/engine/graph/context-analyzer';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { STRATA_VERSION } from '../../src/version';

test('React aliased and namespace context APIs use import identity and reject shadowed calls', () => {
  const code = `import R, {useContext as read} from 'react';
    const one=read(ThemeContext); const two=R['useContext'](AuthContext);
    function local(read:any,R:any){read(FakeContext); R.useContext(OtherContext)}
    {const read=(x:any)=>x; read(BlockContext)}
    const three=read(OutsideContext);
  `;
  const result = extractStateDependencies(code,'react');
  expect(result.contexts).toEqual(['ThemeContext','AuthContext','OutsideContext']);
  const graph = extractComponentContextNodes('Card.tsx',code);
  expect(graph.consumers.map(item => item.key)).toEqual(result.contexts);
  expect(graph.consumers.every(item => item.evidence?.resolution === 'candidate')).toBe(true);
});

test('same-spelled non-React functions, type-only imports and local hook declarations are not React APIs', () => {
  for (const code of [
    `import {useContext} from './other'; useContext(FakeContext);`,
    `import type {useContext} from 'react'; useContext(FakeContext);`,
    `function useContext(x:any){return x}; useContext(FakeContext);`,
    `const thing={useContext(x:any){return x}}; thing.useContext(FakeContext);`,
  ]) {
    expect(extractStateDependencies(code,'react').contexts).toEqual([]);
    expect(extractComponentContextNodes('Card.tsx',code).consumers).toEqual([]);
  }
  expect(extractComponentContextNodes('Card.tsx',`// useContext(GhostContext)
    const text='useContext(PhantomContext)';`).consumers).toEqual([]);
});

test('React useState initializers never become external stores while Nuxt keys remain stores', () => {
  const code=`import React,{useState as state} from 'react'; const [value,setValue]=state('initial'); const [other]=React.useState(seed);`;
  expect(extractStateDependencies(code,'react').stores).toEqual([]);
  expect(extractStateDependencies(code,'next').stores).toEqual([]);
  expect(extractStateDependencies(`const value=useState('session',()=>null)`,'nuxt').stores).toEqual(['session']);
});

test('block, catch, loop and hoisted-var bindings do not leak across scopes', () => {
  const code=`import {useContext as read} from 'react';
    read(FirstContext);
    try{}catch(read){read(CatchContext)}
    for(const read of values){read(LoopContext)}
    function shadow(){read(VarContext); var read=(x:any)=>x}
    function nested(){const read=(x:any)=>x; read(NestedContext)}
    function defaults(value=read(DefaultContext)){var read=(x:any)=>x}
    class Holder{static{var read=(x:any)=>x; read(StaticContext)}}
    read(LastContext);
  `;
  expect(extractStateDependencies(code,'react').contexts).toEqual(['FirstContext','DefaultContext','LastContext']);
});

test('returned atom/context bindings track alias actions without matching shadowed names', () => {
  const code=`import {useAtom as atom} from 'jotai'; import {useContext as read} from 'react';
    const [count,change]=atom(countAtom);
    const {setTheme:apply,theme:label}=read(ThemeContext);
    function actual(){change(1); apply('dark'); console.log(count,label)}
    function fake(change:any,apply:any){change(2); apply('light')}
  `;
  const result=extractStateDependencies(code,'react');
  expect(result.stores).toContain('countAtom');
  const actualLine=4;
  expect(result.items?.filter(item=>item.accessMode==='write').map(item=>[item.identifier,item.lineNumber])).toEqual([
    ['countAtom',actualLine],['ThemeContext',actualLine],
  ]);
});

test('React use separates local createContext from promise-like and imported resource uncertainty', () => {
  const result=extractStateDependencies(`import {use,createContext as make} from 'react'; import {ThemeContext} from './theme';
    const Local=make(null); use(Local); use(UserPromise); use(ThemeContext);`,'react');
  expect(result.contexts).toEqual(['Local','ThemeContext']);
  expect(result.contexts).not.toContain('UserPromise');
  expect(result.diagnostics).toHaveLength(2);
  expect(result.items?.find(item=>item.identifier==='ThemeContext')?.evidence?.method).toBe('react-use-context-name');
  const dynamic=extractStateDependencies(`import {useContext} from 'react'; useContext(selectContext())`,'react');
  expect(dynamic.contexts).toEqual([]);
  expect(dynamic.diagnostics?.[0].code).toBe('REACT_CONTEXT_ARGUMENT_UNRESOLVED');
  expect(extractComponentContextNodes('Card.tsx',`import {useContext} from 'react'; useContext(selectContext())`).consumers).toEqual([]);
});

test('custom imported hooks survive unrelated same-name nested declarations', () => {
  const result=extractStateDependencies(`import {useRemote as remote} from './hook';
    const value=remote(); function unrelated(){function remote(){}; remote()}`,'react');
  expect(result.composables).toEqual(['remote']);
  expect(result.items?.some(item=>item.evidence?.resolution==='candidate')).toBe(true);
});

test('Inertia router import aliases remain dependencies and respect shadowed parameters', () => {
  const result=extractStateDependencies(`import {router as navigate} from '@inertiajs/react';
    navigate.post('/save');
    function fake(navigate:any){navigate.delete('/ignored')}`,'react');
  expect(result.composables).toEqual(['navigate']);
  expect(result.items?.filter(item=>item.accessMode==='write').map(item=>item.lineNumber)).toEqual([2]);
});

test('inspect summary retains unresolved React use resource evidence', async () => {
  const root=await mkdtemp(join(tmpdir(),'strata-react-scope-'));
  try {
    await writeFile(join(root,'package.json'),'{"dependencies":{"react":"19"}}');
    const path=join(root,'Card.tsx');
    await writeFile(path,`import {use} from 'react'; export default function Card(){const value=use(UserPromise); return <div/>}`);
    for(const response_detail of ['full','summary']) {
      const response=await inspectComponentTool.handler({path,project_root:root,format:'json',response_detail,resolve_globals:false});
      expect(response.isError).not.toBe(true);
      expect((response.structuredContent as any).retrieval.omissions.some((item:any)=>item.code==='REACT_USE_RESOURCE_UNVERIFIED')).toBe(true);
    }
  } finally {await rm(root,{recursive:true,force:true})}
});

test('memory-v6 indexes reparse state identifiers under the new binding parser', async () => {
  const root=await mkdtemp(join(tmpdir(),'strata-react-scope-index-'));
  try {
    await writeFile(join(root,'package.json'),'{"dependencies":{"react":"19"}}');
    await writeFile(join(root,'Card.tsx'),`import {useCartStore} from './store'; export default function Card(){const cart=useCartStore();return <div/>}`);
    const db=getWorkspaceDatabase(root,{create:true});
    await syncWorkspace(root);
    db.run("UPDATE state_deps SET identifier='stale-initializer'");
    db.run("UPDATE meta SET value=? WHERE key='cache_version'",[`memory-v6:${STRATA_VERSION}`]);
    expect((await syncWorkspace(root)).modified).toBeGreaterThan(0);
    expect(db.query("SELECT identifier FROM state_deps WHERE identifier='stale-initializer'").all()).toHaveLength(0);
    expect(db.query("SELECT identifier FROM state_deps WHERE identifier='useCartStore'").all().length).toBeGreaterThan(0);
  } finally {closeAllDatabases();await rm(root,{recursive:true,force:true})}
});
