import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { extractReactContract } from '../../src/engine/parsers/contract-react';
import { scanRoutes, extractNextSegmentConfig, formatRoutesAsText } from '../../src/engine/routes';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { auditFrontendTool } from '../../src/tools/audit-frontend';

async function fixture(run: (root: string, write: (path: string, content: string) => Promise<void>) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-react-next-depth-'));
  const write = async (path: string, content: string) => {
    await fs.mkdir(join(root, path, '..'), { recursive: true });
    await fs.writeFile(join(root, path), content);
  };
  try { await run(root, write); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('React imported generic props follow renamed barrel exports and bound inheritance', () => fixture(async (root, write) => {
  await write('base.ts', 'export interface Base<T> { value: T; options?: T[] }');
  await write('props.ts', `import type {Base} from './base'; export interface Input<T = string> extends Base<T> { onSave?: (value:T)=>void; label:string }`);
  await write('barrel.ts', `export type {Input as PublicInput} from './props';`);
  const content = `import type {PublicInput as Props} from './barrel'; export default function Card({label='hello'}: Props<number>){return <div/>}`;
  await write('Card.tsx', content);
  const result = await extractReactContract(join(root, 'Card.tsx'), content, root);
  expect(result.props.find(prop => prop.name === 'value')?.type).toBe('number');
  expect(result.props.find(prop => prop.name === 'options')?.type).toBe('number[]');
  expect(result.props.find(prop => prop.name === 'label')).toMatchObject({required:false,default:"'hello'"});
  expect(result.emits.find(event => event.name === 'onSave')?.payload).toBe('(value:number)=>void');
  expect(result.unresolvedTypes).toBeUndefined();
  expect(result.dependencies?.map(dep => dep.path).sort()).toEqual(['barrel.ts','base.ts','props.ts'].map(path => join(root,path)).sort());
  for (const dep of result.dependencies!) expect(dep.hash).toBe(createHash('sha256').update(await fs.readFile(dep.path)).digest('hex'));
}));

test('React local closed generics and utility wrappers preserve defaults and lexical generic shadows', async () => {
  const result = await extractReactContract('/fixture/Card.tsx', `
    interface Box<T = string> { value:T; values:T[]; map:<T>(value:T)=>T }
    type Input<T> = Partial<Pick<Box<T>, 'value'|'values'|'map'>>;
    export default function Card(props:Input<number>){return <div/>}
  `);
  expect(result.props.map(prop => [prop.name,prop.type,prop.required])).toEqual([
    ['value','number',false],['values','number[]',false],['map','<T>(value:T)=>T',false],
  ]);
  expect(result.unresolvedTypes).toBeUndefined();
});

test('React namespace/default type imports and tsconfig aliases retain resolver dependencies', () => fixture(async (root, write) => {
  await write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@types/*":["types/*"]}}}');
  await write('types/input.ts', 'export default interface Input { title:string }; export type Other = { count:number };');
  const content = `import Input from '@types/input'; import type * as Shapes from './types/input.js'; type Props = Input & Shapes.Other; export default function Card(props:Props){return <div/>}`;
  await write('Card.tsx', content);
  const result = await extractReactContract(join(root,'Card.tsx'),content,root);
  expect(result.props.map(prop => prop.name)).toEqual(['title','count']);
  expect(result.unresolvedTypes).toBeUndefined();
  expect(result.dependencies?.some(dep => dep.path === join(root,'tsconfig.json'))).toBe(true);
  const response = await inspectComponentTool.handler({path:join(root,'Card.tsx'),project_root:root,format:'json'});
  expect(response.isError).not.toBe(true);
  expect((response.structuredContent as any).dependencies.some((dep: any) => dep.path === join(root,'types/input.ts'))).toBe(true);
}));

test('React ambiguous star exports, unresolved component generics and conditional shapes stay partial', () => fixture(async (root, write) => {
  await write('a.ts', 'export type Input = { a:string }');
  await write('b.ts', 'export type Input = { b:string }');
  await write('barrel.ts', `export * from './a'; export * from './b';`);
  let result = await extractReactContract(join(root,'Card.tsx'),`import type {Input} from './barrel'; export default function Card(props:Input){return <div/>}`,root);
  expect(result.props).toEqual([]);
  expect(result.unresolvedTypes?.length).toBeGreaterThan(0);
  result = await extractReactContract(join(root,'Card.tsx'),'type Input<T> = {value:T}; export default function Card<T>(props:Input<T>){return <div/>}',root);
  expect(result.unresolvedTypes?.some(issue => issue.reason.includes('unbound'))).toBe(true);
  result = await extractReactContract(join(root,'Card.tsx'),'type Input<T> = T extends string ? {title:T} : {value:T}; export default function Card(props:Input<string>){return <div/>}',root);
  expect(result.unresolvedTypes?.length).toBeGreaterThan(0);
  result = await extractReactContract(join(root,'Card.tsx'),'type Input = {value:string}; export default function Card(props:Input<number>){return <div/>}',root);
  expect(result.props).toEqual([]);
  expect(result.unresolvedTypes?.some(issue => issue.reason.includes('argument count'))).toBe(true);
}));

test('Next observed effective config uses layout minimum revalidation and nearest region', () => fixture(async (root, write) => {
  await write('next.config.js', 'export default {}');
  await write('app/layout.tsx', `export const revalidate=120; export const preferredRegion='iad1'; export const runtime='nodejs'; export default function Layout(){return null}`);
  await write('app/(shop)/layout.tsx', `export const revalidate=30; export const preferredRegion=['sfo1']; export default function Layout(){return null}`);
  await write('app/(shop)/products/page.tsx', `export const revalidate=90; export default function Page(){return null}`);
  await write('app/(shop)/other/page.tsx', `export const revalidate=0; export default function Page(){return null}`);
  await write('app/api/route.ts', `export const revalidate=600; export function GET(){return new Response('ok')}`);
  const manifest = await scanRoutes({targetPath:root});
  const effective = manifest.routes.find(route => route.path === '/products' && route.type === 'page')!.nextEffectiveSegmentConfig!;
  expect(effective.config).toEqual({revalidate:30,preferredRegion:['sfo1'],runtime:'nodejs'});
  expect(effective.sources).toHaveLength(3);
  expect(effective.freshness).toBe('current');
  expect(manifest.routes.find(route => route.path === '/other' && route.type === 'page')!.nextEffectiveSegmentConfig!.config.revalidate).toBe(0);
  expect(manifest.routes.find(route => route.type === 'api')!.nextEffectiveSegmentConfig!.config.revalidate).toBe(600);
  expect(formatRoutesAsText(manifest)).toContain('runtime behavior unverified');
}));

test('Next dynamic inherited config, export aliases and edge revalidate retain unresolved evidence', () => fixture(async (root, write) => {
  await write('next.config.js','export default {}');
  await write('app/layout.tsx', `export const revalidate=getInterval(); export const preferredRegion='iad1'; export default function Layout(){return null}`);
  await write('app/page.tsx', `export const revalidate=60; export const preferredRegion=selectRegion(); export default function Page(){return null}`);
  let manifest = await scanRoutes({targetPath:root});
  let effective = manifest.routes.find(route => route.type === 'page')!.nextEffectiveSegmentConfig!;
  expect(effective.config.revalidate).toBeUndefined();
  expect(effective.config.preferredRegion).toBeUndefined();
  expect(effective.unresolvedFields.map(issue => issue.field)).toContain('revalidate');
  expect(effective.unresolvedFields.map(issue => issue.field)).toContain('preferredRegion');
  await write('app/layout.tsx', `export const revalidate=120; export default function Layout(){return null}`);
  await write('app/page.tsx', `export const runtime='edge'; export default function Page(){return null}`);
  manifest = await scanRoutes({targetPath:root});
  effective = manifest.routes.find(route => route.type === 'page')!.nextEffectiveSegmentConfig!;
  expect(effective.config.revalidate).toBeUndefined();
  expect(effective.unresolvedFields.some(issue => issue.reason.includes('edge runtime'))).toBe(true);
  await write('app/page.tsx', `export const runtime=selectRuntime(); export const revalidate=10; export default function Page(){return null}`);
  manifest = await scanRoutes({targetPath:root});
  effective = manifest.routes.find(route => route.type === 'page')!.nextEffectiveSegmentConfig!;
  expect(effective.config.revalidate).toBeUndefined();
  expect(effective.unresolvedFields.some(issue => issue.reason.includes('runtime is unresolved'))).toBe(true);
  expect(extractNextSegmentConfig(`export {interval as revalidate} from './config'`)?.unresolvedFields?.[0].field).toBe('revalidate');
  expect(extractNextSegmentConfig(`export * from './config'`)?.unresolvedFields?.[0].field).toBe('*');
  expect(extractNextSegmentConfig(`export declare const revalidate:number`)?.unresolvedFields?.[0].field).toBe('revalidate');
  expect(extractNextSegmentConfig(`export const {revalidate}=settings`)?.unresolvedFields?.[0].field).toBe('revalidate');
  for (const response_detail of ['full', 'summary']) {
    const response = await auditFrontendTool.handler({target:'routes',path:root,format:'json',response_detail});
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as any).retrieval.omissions.some((issue: any) => issue.code === 'NEXT_EFFECTIVE_CONFIG_PARTIAL')).toBe(true);
  }
}));
