import { expect, test } from 'bun:test';
import { extractRenderBoundary } from '../../src/engine/contract';

const hooks = (code: string) => extractRenderBoundary('/project/app/page.tsx', code, 'next')
  .violations?.filter(item => item.code === 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT') ?? [];

test('RSC diagnostics resolve React aliases, namespaces and wrapped calls', () => {
  const result = hooks(`import R, {useState as state, useEffect as effect} from 'react';
    const [value] = (state)(0); R['useContext'](Theme); effect(()=>{}); state(1);`);
  expect(result).toHaveLength(1);
  expect(result[0].message).toContain('useState, useContext, useEffect');
});

test('RSC diagnostics ignore textual mentions, unused and type-only imports and unrelated calls', () => {
  for (const code of [
    `// useState(0)\nconst text='useEffect()';`,
    `import {useState} from 'react'; export default function Page(){return <p>useState</p>}`,
    `import type {useState} from 'react'; useState(0);`,
    `import {useState} from './store'; useState(0);`,
    `function useState(x:any){return x}; useState(0);`,
    `const R={useState(x:any){return x}}; R.useState(0);`,
  ]) expect(hooks(code)).toEqual([]);
});

test('RSC diagnostics honor parameter, block, catch, loop and hoisted variable shadowing', () => {
  expect(hooks(`import R, {useState as state} from 'react';
    function param(state:any,R:any){state(0);R.useState(0)}
    {const state=(x:any)=>x;state(0)}
    try{}catch(state){state(0)}
    for(const state of values){state(0)}
    function hoisted(){state(0);var state=(x:any)=>x}
    class Holder{static{var state=(x:any)=>x;state(0)}}
  `)).toEqual([]);
  expect(hooks(`import {useState as state} from 'react';
    function defaults(value=state(0)){var state=(x:any)=>x}
  `)).toHaveLength(1);
});

test('RSC hook checks retain explicit directive and framework boundaries', () => {
  const code=`import {useState} from 'react'; useState(0);`;
  for (const directive of ["'use client';", "'use server';"]) expect(hooks(directive+code)).toEqual([]);
  expect(extractRenderBoundary('/project/src/Card.tsx',code,'react').violations).toBeUndefined();
  expect(hooks(`import {use as resource} from 'react'; resource(promise);`)).toEqual([]);
});
