import { expect, test } from 'bun:test';
import { extractRenderBoundary } from '../../src/engine/contract';

async function events(content: string) {
  const boundary = extractRenderBoundary('/project/app/page.tsx', content, 'next');
  return { boundary: boundary.violations?.filter(item => item.code === 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT') ?? [] };
}

test('RSC boundary detects explicit host event candidates', async () => {
  const code = `export default function Page(){return <><button onClick={handler}/><input onInputCapture={(e)=>save(e)}/><button onClick={handler}/></>}`;
  const result = await events(code);
  expect(result.boundary).toHaveLength(1);
  expect(result.boundary[0].message).toContain('onClick, onInputCapture');
});

test('RSC event diagnostics ignore text, declarations, component props, custom elements and spreads', async () => {
  for (const code of [
    `// onClick=handler\nconst text='onChange=handler'; const onSubmit=save;`,
    `const item={onClick:handler}; export default ()=> <p>onClick=handler</p>`,
    `export default ()=> <Client onClick={handler} onSuccess={callback}/>`,
    `export default ()=> <UI.Button onClick={handler}/>`,
    `export default ()=> <my-button onClick={handler}/>`,
    `export default ()=> <button {...handlers}/>`,
    `export default ()=> <button onClick:custom={handler}/>`,
  ]) {
    const result = await events(code);
    expect(result.boundary).toEqual([]);
  }
});

test('obvious non-handler values do not establish DOM event candidates', async () => {
  const result = await events(`export default ()=> <><button onClick/><button onClick="text"/>
    <button onClick={null}/><button onClick={(false as const)}/><button onClick={42}/>
    <button onClick={\`text\`}/><button onClick={void 0}/></>`);
  expect(result.boundary).toEqual([]);
});

test('client directive suppresses event checks while non-prologue strings do not', async () => {
  const code = `export default ()=> <button onClick={handler}/>`;
  const client = await events(`'use client';${code}`);
  expect(client.boundary).toEqual([]);
  const decoy = await events(`const text='use client';${code}`);
  expect(decoy.boundary).toHaveLength(1);
});
