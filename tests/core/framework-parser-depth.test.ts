import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractReactContract } from '../../src/engine/parsers/contract-react';
import { extractAstroContract } from '../../src/engine/parsers/contract-astro';
import { extractSvelteContract } from '../../src/engine/parsers/contract-svelte';
import { extractVueContract } from '../../src/engine/parsers/contract-vue';
import { extractNuxtPageMeta, extractNextSegmentConfig, extractApiHandlers, scanRoutes } from '../../src/engine/routes';
import { extractRenderBoundary } from '../../src/engine/contract';
import { moduleDirective } from '../../src/engine/parsers/ts-syntax';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { readSourceSnapshot, readSourceRef } from '../../src/engine/source-file';
import { getComponentTree } from '../../src/engine/tree';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'strata-parser-depth-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('React follows imported wrapper aliases and variable chains with renamed destructuring defaults', async () => {
  const contract = await extractReactContract('/fixture/Card.tsx', `
    import { memo as cache, forwardRef as forward } from 'react';
    interface Base { title: string; count?: number; hidden: boolean }
    type Props = Readonly<Required<Pick<Base, 'title' | 'count'>>>;
    const Inner = forward<HTMLDivElement, Props>(({ title: label = 'hello', count }, ref) => <div ref={ref}>{label}{count}</div>);
    const Card = cache((Inner as typeof Inner));
    export default (Card satisfies unknown);
  `);
  expect(contract.props.map(prop => prop.name)).toEqual(['title', 'count']);
  expect(contract.props[0]).toMatchObject({ name: 'title', default: "'hello'", required: false });
  expect(contract.props[1]).toMatchObject({ name: 'count', required: true });
  expect(contract.unresolvedTypes).toBeUndefined();
});

test('React resolves local utility compositions, parenthesized types and quoted prop names', async () => {
  const contract = await extractReactContract('/fixture/Widget.tsx', `
    import * as R from 'react';
    interface Base { 'data-label': string; count: number; hidden: boolean }
    type Props = (Omit<Partial<Base>, 'hidden'>) & { active: boolean };
    export default R.memo(function Widget({ 'data-label': label = 'ok' }: Props) { return <div>{label}</div> });
  `);
  expect(contract.props.map(prop => [prop.name, prop.required])).toEqual([['data-label', false], ['count', false], ['active', true]]);
  expect(contract.props[0].default).toBe("'ok'");
});

test('React reports unresolved missing imported, recursive, unbound generic and computed-key prop types', async () => {
  for (const type of ['External', 'Box', 'Pick<Local, keyof Local>', 'Loop', 'Local | { other: number }']) {
    const contract = await extractReactContract('/fixture/Card.tsx', `
      import type { External } from './external';
      type Box<T> = { item: T }; type Loop = Loop;
      type Local = { label: string };
      export default function Card(props: ${type}) { return <div/> }
    `);
    expect(contract.unresolvedTypes?.length).toBeGreaterThan(0);
  }
});

test('React does not mistake unrelated wrappers or missing arguments for supported React components', async () => {
  for (const code of [
    `import { memo } from './custom'; interface Props { secret: string } export default memo((props: Props) => <div/>);`,
    `import { memo } from 'react'; export default memo();`,
    `const Card = Other; const Other = Card; export default Card;`,
  ]) {
    const contract = await extractReactContract('/fixture/Card.tsx', code);
    expect(contract.props).toEqual([]);
    expect(contract.unresolvedTypes?.length).toBeGreaterThan(0);
  }
  const anonymous = await extractReactContract('/fixture/Card.tsx', 'export default function({ title }: { title: string }) { return <div>{title}</div> }');
  expect(anonymous.props[0].name).toBe('title');
});

test('Nuxt unwraps TypeScript metadata expressions and normalizes literal property keys', () => {
  const meta = extractNuxtPageMeta(`<script setup lang="ts">
    definePageMeta(({ 'layout': ('admin' as const), ['alias']: ['/admin'] as const,
      middleware: (['auth', 'tenant'] satisfies string[]), keepalive: (false), pageTransition: true } satisfies PageMeta));
  </script><template><div/></template>`);
  expect(meta).toMatchObject({ layout: 'admin', alias: ['/admin'], middleware: ['auth', 'tenant'], keepalive: false, pageTransition: true });
  expect(meta?.unresolvedFields).toBeUndefined();
});

test('Nuxt preserves uncertainty for dynamic arrays, override spreads and repeated fields', () => {
  const meta = extractNuxtPageMeta(`definePageMeta({layout: 'admin', ...extra, alias: ['/known', dynamic], middleware: ['auth', () => true], layout: selected})`);
  expect(meta?.layout).toBeUndefined();
  expect(meta?.alias).toBeUndefined();
  expect(meta?.middleware).toBeUndefined();
  expect(meta?.unresolvedFields?.map(item => item.field)).toEqual(['*', 'alias', 'middleware', 'layout']);
  expect(extractNuxtPageMeta('definePageMeta(metadata)')?.unresolvedFields?.[0].field).toBe('*');
  expect(extractNuxtPageMeta('definePageMeta({layout:"one"}); definePageMeta({layout:"two"})')?.layout).toBeUndefined();
});

test('Nuxt does not interpret nested helper calls, template text or regular-script decoys as page metadata', () => {
  for (const code of [
    'function helper() { definePageMeta({layout:"decoy"}) }',
    '<template><div>definePageMeta({layout:"decoy"})</div></template>',
    '<script>definePageMeta({layout:"decoy"})</script><template><div/></template>',
  ]) expect(extractNuxtPageMeta(code)).toBeUndefined();
});

test('Nuxt route layouts follow AST metadata and keep dynamic layout unresolved', async () => fixture(async root => {
  await mkdir(join(root, 'pages'));
  await mkdir(join(root, 'layouts'));
  await writeFile(join(root, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
  await writeFile(join(root, 'layouts/default.vue'), '<template><slot/></template>');
  await writeFile(join(root, 'layouts/admin.vue'), '<template><slot/></template>');
  await writeFile(join(root, 'pages/index.vue'), '<script setup>definePageMeta({layout: selected})</script><template><div/></template>');
  await writeFile(join(root, 'pages/admin.vue'), '<script setup lang="ts">definePageMeta({layout: "admin"} as const)</script><template><div/></template>');
  await writeFile(join(root, 'pages/plain.vue'), '<template><!-- layout: false --><div/></template>');
  const routes = (await scanRoutes({ targetPath: root })).routes;
  expect(routes.find(route => route.path === '/')?.layouts).toBeUndefined();
  expect(routes.find(route => route.path === '/admin')?.layouts).toEqual([join(root, 'layouts/admin.vue')]);
  expect(routes.find(route => route.path === '/plain')?.layouts).toEqual([join(root, 'layouts/default.vue')]);
}));

test('Next module directives require a real prologue and exclude function-local strings and template literals', () => {
  for (const code of ["// comment\n'use strict'; /* comment */ 'use client'; export default function Card(){ return <div/> }", "\uFEFF'use client'; export const Card = () => <div/>;"])
    expect(extractRenderBoundary('/app/Card.tsx', code, 'next').boundary).toBe('client-component');
  for (const code of ["export function f(){\n'use client';\n}", "import x from 'x';\n'use client';", "const text = `\n'use client'\n`;", "('use client');", "`use client`;", "'use client' + 'suffix';"])
    expect(moduleDirective(code, 'use client')).toBeUndefined();
  expect(extractRenderBoundary('/app/Card.tsx', "export function f(){\n'use server';\n}", 'next').boundary).toBe('server-component');
});

test('Next segment config preserves dynamic values as unresolved instead of silently filtering arrays', () => {
  expect(extractNextSegmentConfig(`export const runtime = ('edge' as const); export const revalidate = (600 satisfies number);`)).toMatchObject({ runtime: 'edge', revalidate: 600 });
  const config = extractNextSegmentConfig(`export const preferredRegion = ['iad1', region]; export const revalidate = 60 * 10;`);
  expect(config?.preferredRegion).toBeUndefined();
  expect(config?.revalidate).toBeUndefined();
  expect(config?.unresolvedFields?.map(item => item.field)).toEqual(['preferredRegion', 'revalidate']);
});

test('Next handler scanner reads AST exports including aliases and ignores comment/string/type decoys', async () => fixture(async root => {
  const file = join(root, 'route.ts');
  await writeFile(file, `// export function DELETE() {}
    const example = "export const PUT = () => {}";
    async function handler() {} export { handler as GET };
    export { other as POST } from './handlers';
    export type { HEAD } from './types';
    export default function DELETE() {}
    export const PATCH = handler, OPTIONS = handler;
  `);
  expect(await extractApiHandlers(file)).toEqual(['GET', 'POST', 'PATCH', 'OPTIONS']);
}));

test('Next tree inheritance uses module directives rather than function-local decoys', async () => fixture(async root => {
  const parent = join(root, 'Parent.tsx');
  const child = join(root, 'Child.tsx');
  await writeFile(child, 'export default function Child(){return <div/>}');
  await writeFile(parent, `import Child from './Child'; export default function Parent(){\n'use client';\nreturn <Child/>}`);
  const server = await getComponentTree({ entryPath: parent, workspaceRoot: root, maxDepth: 2 });
  expect(server.root.children?.[0].transitiveBoundary).toBeUndefined();
  await writeFile(parent, `// comment\n'use strict'; 'use client'; import Child from './Child'; export default function Parent(){return <Child/>}`);
  const client = await getComponentTree({ entryPath: parent, workspaceRoot: root, maxDepth: 2 });
  expect(client.root.children?.[0].transitiveBoundary).toBe('client-hydrated (inherited from parent)');
}));

test('inspect handler keeps unresolved framework metadata visible in JSON, text and summary', async () => fixture(async root => {
  for (const [name, content, code] of [
    ['Page.vue', '<script setup>definePageMeta({middleware:["auth", guard]})</script><template><div/></template>', 'NUXT_PAGE_META_UNRESOLVED'],
    ['Page.tsx', 'export const revalidate = getInterval(); export default function Page(){return <div/>}', 'NEXT_SEGMENT_CONFIG_UNRESOLVED'],
  ]) {
    const file = join(root, name);
    await writeFile(file, content);
    for (const extra of [{ format: 'json' }, { format: 'text' }, { format: 'json', response_detail: 'summary' }]) {
      const response = await inspectComponentTool.handler({ path: file, project_root: root, ...extra });
      expect(response.isError).not.toBe(true);
      expect((response.structuredContent as any).retrieval.omissions.some((item: any) => item.code === code)).toBe(true);
      expect((response.structuredContent as any).decision.status).toBe('partial');
    }
  }
}));

test('Astro resolves exact Props inheritance and utility types without unrelated interfaces or rest bindings', async () => {
  const contract = await extractAstroContract('/fixture/Card.astro', `---
    interface Base { 'data-label': string; hidden: boolean; count?: number }
    interface DecoyProps { decoy: string }
    type Props = Omit<Base, 'hidden'>;
    const { 'data-label': label = 'Hello', ...rest } = (Astro.props satisfies Props);
    function helper() { const { fake } = Astro.props; }
---
<div>{label}</div>`);
  expect(contract.props.map(prop => prop.name)).toEqual(['data-label', 'count']);
  expect(contract.props[0]).toMatchObject({ default: "'Hello'", required: false });
  expect(contract.unresolvedTypes).toBeUndefined();
  const external = await extractAstroContract('/fixture/Card.astro', '---\nimport type { External } from "./types"; interface Props extends External { own: string }\n---\n<div/>');
  expect(external.props[0].name).toBe('own');
  expect(external.unresolvedTypes?.[0].name).toBe('External');
});

test('Svelte resolves only the annotated props shape, keeping bindable defaults and typed rest fields', async () => {
  const contract = await extractSvelteContract('/fixture/Card.svelte', `<script lang="ts">
    interface Decoy { title: number; unrelated: boolean }
    interface Base { title: string; count?: number; 'data-label'?: string }
    type Input = Readonly<Partial<Base>>;
    let { title = $bindable('hello'), 'data-label': label = 'ok', ...rest }: Input = $props();
  </script><div>{title}</div>`);
  expect(contract.props.map(prop => prop.name)).toEqual(['title', 'count', 'data-label']);
  expect(contract.props[0]).toMatchObject({ type: 'string', default: "'hello'", required: false });
  expect(contract.models).toContainEqual({ name: 'title' });
  expect(contract.props[2].default).toBe("'ok'");
  expect(contract.unresolvedTypes).toBeUndefined();
});

test('Svelte untyped props do not inherit unrelated type declarations or module exports', async () => {
  const contract = await extractSvelteContract('/fixture/Card.svelte', `<script module lang="ts">export let moduleOnly = 1;</script>
    <script lang="ts">interface Decoy { value: string }; let { value, ...rest } = $props();</script><div/>`);
  expect(contract.props.map(prop => prop.name)).toEqual(['value']);
  expect(contract.props[0].type).toBe('any');
  const external = await extractSvelteContract('/fixture/Card.svelte', '<script lang="ts">import type { Input } from "./types"; let props: Input = $props();</script><div/>');
  expect(external.unresolvedTypes?.[0].name).toBe('Input');
});

test('Vue defaults preserve aliased names and nested expression boundaries', async () => {
  const contract = await extractVueContract('/fixture/Card.vue', `<script setup lang="ts">
    const { title: label = 'hello, world', options = { first: 1, second: [2, 3] }, text = format('a', 'b') } = defineProps<{ title?: string; options?: object; text?: string; toString?: string }>();
  </script><template><div>{{ label }}</div></template>`, { });
  const props = new Map(contract.props.map(prop => [prop.name, prop]));
  expect(props.get('title')?.default).toBe("'hello, world'");
  expect(props.get('options')?.default).toBe('{ first: 1, second: [2, 3] }');
  expect(props.get('text')?.default).toBe("format('a', 'b')");
  expect(props.get('toString')?.default).toBeUndefined();
});

test('Vue withDefaults supports TypeScript wrappers and reports dynamic default overrides', async () => {
  const contract = await extractVueContract('/fixture/Card.vue', `<script setup lang="ts">
    const props = withDefaults(defineProps<{ title?: string; count?: number }>(), ({ title: 'wrapped', ...extra, count: 1 } as const));
  </script><template><div/></template>`, { });
  expect(contract.props.find(prop => prop.name === 'title')?.default).toBeUndefined();
  expect(contract.props.find(prop => prop.name === 'count')?.default).toBe('1');
  expect(contract.unresolvedTypes?.some(item => item.name === 'withDefaults')).toBe(true);
  const shorthand = await extractVueContract('/fixture/Card.vue', `<script setup lang="ts">
    const props = withDefaults(defineProps<{ title?: string }>(), { title: 'earlier', title });
  </script><template><div/></template>`, { });
  expect(shorthand.props[0].default).toBeUndefined();
  expect(shorthand.unresolvedTypes?.some(item => item.name === 'title')).toBe(true);
});
