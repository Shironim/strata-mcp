import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { extractReactContract } from '../../src/engine/parsers/contract-react';
import { extractLocalImports } from '../../src/engine/tree';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { scanRoutes } from '../../src/engine/routes';
import { sliceSymbol, formatSymbolSliceAsText } from '../../src/engine/slicer';
import { traceStateChain } from '../../src/engine/storage/state-storage';
import { findTool } from '../../src/tools';
import { extractRuleKeywords } from '../../src/engine/search';
const roots: string[] = [];
function workspace() {
  const root = mkdtempSync('/tmp/strata-review-'); roots.push(root);
  put(root, 'package.json', '{"dependencies":{"vue":"3","nuxt":"4","react":"19","astro":"5"}}');
  return root;
}
function put(root: string, file: string, content: string) {
  const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
}
afterEach(() => { closeAllDatabases(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

test('state extraction ignores type imports, template prose, comments and string mutations', () => {
  const result = extractStateDependencies(`<script setup lang="ts">
import type { useFakeStore } from './fake';
const cart = useCartStore();
const text = 'cart.checkout()';
/* cart.checkout(); router.post('/x'); */
</script><template><!-- usePhantom() --><p>useGhost()</p>{{ useReal().value }}</template>`, 'vue');
  expect(result.stores).toEqual(['useCartStore']);
  expect(result.composables).toEqual(['useReal']);
  expect(result.items?.some(i => i.accessMode === 'write')).toBe(false);
});
test('state calls preserve special Redux, Nanostore and inject classifications', () => {
  const result = extractStateDependencies("useSelector(s => s); useDispatch(); useStore($cart); inject(SessionKey);", 'react');
  expect(result.stores).toEqual(['useSelector', 'useDispatch', '$cart']);
  expect(result.contexts).toEqual(['SessionKey']);
  expect(result.composables).toEqual([]);
});
test('local state declarations are independent of declaration order and template AST', () => {
  const result = extractStateDependencies('<script setup>const a = useLocal(); function useLocal() { return 1 }</script><template><template #default>{{ useActual() }}</template>{{ useAfter() }}</template>', 'vue');
  expect(result.composables).toEqual(['useActual', 'useAfter']);
});
test('dynamic import extraction ignores comments and strings', () => {
  const result = extractLocalImports(`// const Fake = lazy(() => import('./Fake'));
const prose = "const Ghost = lazy(() => import('./Ghost'))";
const Real = React.lazy(() => import('./Real'));`);
  expect(result.map(i => i.name)).toEqual(['Real']);
});
test('Astro frontmatter imports survive an inline client script', async () => {
  const root = workspace(); const child = put(root, 'Child.astro', '<span/>');
  put(root, 'App.astro', "---\nimport Child from './Child.astro';\n---\n<script>console.log('client')</script>\n<Child title={true ? 'hello world' : 'no'} />");
  const result = await generatePatchPlan({ componentPath: child, targetPath: root, refactorType: 'remove_prop', oldName: 'title' });
  expect(result.patches).toHaveLength(1);
  expect(result.patches[0].oldSnippet).toBe("title={true ? 'hello world' : 'no'}");
});
test.each(['\n', '\r\n'])('Astro patches refer to original source coordinates with %j', async newline => {
  const root = workspace(); const child = put(root, 'Child.astro', '<span/>');
  const code = ['---', "import Child from './Child.astro';", 'const x = 1;', '---', '<Child', " title={x ? 'hello world' : 'no'}", '/>'].join(newline);
  put(root, 'App.astro', code);
  const result = await generatePatchPlan({ componentPath: child, targetPath: root, refactorType: 'remove_prop', oldName: 'title' });
  expect(result.patches).toHaveLength(1);
  const p = result.patches[0]; expect(p.line).toBe(6); expect(p.column).toBe(2);
  const offset = code.split('\n').slice(0, p.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + p.column - 1;
  expect(code.slice(offset, offset + p.oldSnippet.length)).toBe(p.oldSnippet);
});
test('route scope filters results without changing route names or layout resolution', async () => {
  const root = workspace(); put(root, 'nuxt.config.ts', 'export default {}');
  const page = put(root, 'app/pages/account/index.vue', '<template><div/></template>');
  const layout = put(root, 'app/layouts/default.vue', '<template><slot/></template>');
  const result = await scanRoutes({ targetPath: root, scopePath: 'app/pages/account' });
  expect(result.framework).toBe('nuxt');
  expect(result.routes.map(r => r.path)).toEqual(['/account']);
  expect(result.routes[0].filePath).toBe(page); expect(result.routes[0].layouts).toEqual([layout]);
});
test('routes and dead-state honor exclusions in individual and all audits', async () => {
  const root = workspace(); put(root, 'nuxt.config.ts', 'export default {}');
  put(root, 'app/pages/index.vue', '<template><div/></template>');
  put(root, 'app/pages/ignored/index.vue', '<template><div/></template>');
  put(root, 'ignored/useSecret.ts', 'export function useSecret(){}');
  getWorkspaceDatabase(root, { create: true });
  for (const target of ['routes', 'dead-state', 'all']) {
    const response = await findTool('audit_frontend')!.handler({ path: root, target, exclude_dirs: ['ignored'], format: 'json' });
    expect(response.isError).not.toBe(true);
    const result = JSON.parse((response.content[0] as any).text);
    if (target !== 'dead-state') expect((target === 'all' ? result.routes : result).routes.map((r: any) => r.path)).toEqual(['/']);
    if (target !== 'routes') expect(JSON.stringify(target === 'all' ? result.unusedState : result)).not.toContain('useSecret');
  }
});
test('unindexed symbol inspection reports unknown graph evidence without creating an index', async () => {
  const root = workspace(); const path = put(root, 'useFoo.ts', 'export function useFoo() { return 1; }');
  const result = await sliceSymbol({ path, symbolName: 'useFoo' });
  expect(result?.blastRadius?.totalConsumers).toBeNull();
  expect((result?.blastRadius as any)?.status).toBe('unknown');
  expect(formatSymbolSliceAsText(result!)).toContain('unknown');
});
test('state declaration cannot be selected from a comment or type declaration', async () => {
  const root = workspace(); put(root, 'useFoo.ts', '// export function useFoo() {}\nexport type useFoo = string;');
  const path = put(root, 'store.ts', 'export async function useFoo() { return {}; }');
  put(root, 'App.vue', '<script setup>import {useFoo} from "./store"; const foo = useFoo();</script><template/>');
  getWorkspaceDatabase(root, { create: true });
  expect((await traceStateChain(root, { identifier: 'useFoo' })).entryFile).toBe(path);
});
test('React inline props and default exported identifiers resolve the consumed type', async () => {
  const inline = await extractReactContract('/tmp/Widget.tsx', 'export default function Widget(props: { title: string; count?: number }) { return <div/>; }');
  expect(inline.props.map(p => p.name)).toEqual(['title', 'count']);
  const named = await extractReactContract('/tmp/Widget.tsx', 'interface Props { wrong: string } interface Actual { right: number } const Screen = (props: Actual) => <div/>; export default Screen;');
  expect(named.props.map(p => p.name)).toEqual(['right']);
});
test('removing direct scoped slots removes their content and preserves adjacent slots', async () => {
  const root = workspace(); const child = put(root, 'Child.vue', '<template><slot/></template>');
  put(root, 'App.vue', '<script setup>import Child from "./Child.vue";</script><template><Child v-slot="{ user }"><h1>{{user.name}}</h1></Child><p>keep</p></template>');
  const result = await generatePatchPlan({ componentPath: child, targetPath: root, refactorType: 'remove_slot', oldName: 'default' });
  expect(result.patches).toHaveLength(1);
  expect(result.patches[0].oldSnippet).toBe('<Child v-slot="{ user }"><h1>{{user.name}}</h1></Child>');
});
test('dynamic slot arguments do not generate a static removal patch', async () => {
  const root = workspace(); const child = put(root, 'Child.vue', '<template><slot/></template>');
  put(root, 'App.vue', '<script setup>import Child from "./Child.vue";</script><template><Child><template #[header]>keep</template></Child></template>');
  const result = await generatePatchPlan({ componentPath: child, targetPath: root, refactorType: 'remove_slot', oldName: 'header' });
  expect(result.patches).toHaveLength(0);
});
test('YAML flow rules never prune using keywords from a negative clause', () => {
  expect(extractRuleKeywords('id: example\nlanguage: ts\nrule:\n  all:\n    - kind: call_expression\n    - not: { pattern: console.log($$$) }')).toEqual([]);
  expect(extractRuleKeywords('id: example\nlanguage: ts\nrule:\n  pattern: foo()\n  not: { pattern: bar() }')).toEqual([]);
});
test('unique auto imports remain consumers and an explicit alias does not resolve an ambiguous basename', async () => {
  const root = workspace(); const target = put(root, 'a/Button.vue', '<template><button/></template>');
  put(root, 'App.vue', '<template><Button title="auto"/></template>');
  const options = { componentPath: target, targetPath: root, refactorType: 'rename_prop' as const, oldName: 'title', newName: 'label' };
  expect((await generatePatchPlan(options)).patches).toHaveLength(1);
  put(root, 'b/Button.vue', '<template><button/></template>');
  put(root, 'App.vue', '<script setup>import Known from "./a/Button.vue";</script><template><Known title="yes"/><Button title="ambiguous"/></template>');
  const patches = (await generatePatchPlan(options)).patches;
  expect(patches.map(p => p.targetTag)).toEqual(['Known']);
});
test('nested YAML negative pattern does not supply a mandatory keyword', () => {
  expect(extractRuleKeywords('id: example\nlanguage: ts\nrule:\n  all:\n    - kind: call_expression\n    - not:\n        pattern: console.log($$$)')).toEqual([]);
});
test('indexed symbol inspection reports unknown when refresh fails', async () => {
  const root = workspace(); const path = put(root, 'useFoo.ts', 'export function useFoo() { return 1; }');
  getWorkspaceDatabase(root, { create: true }); await syncWorkspace(root);
  put(root, 'Broken.vue', '<template><div></template>');
  const result = await sliceSymbol({ path, symbolName: 'useFoo' });
  expect(result?.blastRadius?.status).toBe('unknown'); expect(result?.blastRadius?.totalConsumers).toBeNull();
});
test.each(["import Button from 'external-library';", "import Button from './Missing.vue';", "import Button from 'Button.vue';"])('explicit unresolved bindings override auto-import guesses: %s', async binding => {
  const root = workspace(); const target = put(root, 'Button.vue', '<template><button/></template>');
  put(root, 'App.vue', `<script setup>${binding}</script><template><Button title="unrelated"/></template>`);
  const result = await generatePatchPlan({ componentPath: target, targetPath: root, refactorType: 'rename_prop', oldName: 'title', newName: 'label' });
  expect(result.patches).toHaveLength(0);
});
test('cache refresh reparses old state classifications after the parser version changes', async () => {
  const root = workspace(); put(root, 'App.vue', '<script setup>const cart = useCartStore();</script><template/>');
  const db = getWorkspaceDatabase(root, { create: true }); await syncWorkspace(root);
  db.run("UPDATE state_deps SET identifier = 'usePhantom'");
  db.run("UPDATE meta SET value = 'memory-v3:0.7.10' WHERE key = 'cache_version'");
  expect((await syncWorkspace(root)).modified).toBeGreaterThan(0);
  expect(db.query("SELECT identifier FROM state_deps WHERE identifier = 'usePhantom'").all()).toHaveLength(0);
  expect((await syncWorkspace(root)).modified).toBe(0);
});
test('multi-hop role selection propagates only ancestors of matching direct consumers', async () => {
  const root = workspace(); put(root, 'useFoo.ts', 'export function useFoo() { return {count: 1, update() {}}; }');
  put(root, 'Reader.vue', '<script setup>const foo = useFoo(); const count = foo.count;</script><template/>');
  put(root, 'Writer.vue', '<script setup>const foo = useFoo(); foo.update();</script><template/>');
  put(root, 'App.vue', '<script setup>import Reader from "./Reader.vue"; import Writer from "./Writer.vue";</script><template><Reader/><Writer/></template>');
  getWorkspaceDatabase(root, { create: true });
  for (const role of ['readers', 'mutators', 'all'] as const) {
    for (const depth of [1, 2]) {
      const result = await traceStateChain(root, { identifier: 'useFoo', direction: 'consumers', role, maxDepth: depth });
      const files = result.consumers.map(c => c.filePath);
      if (role !== 'mutators') expect(files).toContain(join(root, 'Reader.vue'));
      else expect(files).not.toContain(join(root, 'Reader.vue'));
      if (role !== 'readers') expect(files).toContain(join(root, 'Writer.vue'));
      else expect(files).not.toContain(join(root, 'Writer.vue'));
      if (depth === 2) expect(files).toContain(join(root, 'App.vue'));
    }
  }
});
test('Astro HTML comments cannot produce an attribute patch', async () => {
  const root = workspace(); const target = put(root, 'Child.astro', '<span/>');
  put(root, 'App.astro', "---\nimport Child from './Child.astro';\n---\n<!-- <Child title='fake'/> -->\n<Child title='real'/>");
  const result = await generatePatchPlan({ componentPath: target, targetPath: root, refactorType: 'remove_prop', oldName: 'title' });
  expect(result.patches.map(p => p.oldSnippet)).toEqual(["title='real'"]);
});
test('Vue shorthand prop rename preserves the original bound variable', async () => {
  const root = workspace(); const target = put(root, 'Child.vue', '<template/>');
  put(root, 'App.vue', '<script setup>import Child from "./Child.vue"; const title = "value";</script><template><Child :title/></template>');
  const result = await generatePatchPlan({ componentPath: target, targetPath: root, refactorType: 'rename_prop', oldName: 'title', newName: 'label' });
  expect(result.patches[0].newSnippet).toBe(':label="title"');
});
test('removing an outer slot does not emit overlapping patches inside its subtree', async () => {
  const root = workspace(); const target = put(root, 'Child.vue', '<template/>');
  const subtree = '<template #header><Child><template #header>nested</template></Child></template>';
  put(root, 'App.vue', `<script setup>import Child from "./Child.vue";</script><template><Child>${subtree}<p>keep</p></Child></template>`);
  const result = await generatePatchPlan({ componentPath: target, targetPath: root, refactorType: 'remove_slot', oldName: 'header' });
  expect(result.patches).toHaveLength(1); expect(result.patches[0].oldSnippet).toBe(subtree);
});
test('scoped dead-state audit retains consumers outside the finding scope', async () => {
  const root = workspace(); put(root, 'hooks/useActive.ts', 'export function useActive() { return 1; }');
  getWorkspaceDatabase(root, { create: true }); await syncWorkspace(root);
  put(root, 'App.vue', '<script setup>import {useActive} from "./hooks/useActive"; const value = useActive();</script><template/>');
  getWorkspaceDatabase(root, { create: true });
  const response = await findTool('audit_frontend')!.handler({ path: root, target: 'dead-state', scope_path: 'hooks', format: 'json' });
  expect(response.isError).not.toBe(true);
  const result = JSON.parse((response.content[0] as any).text);
  expect(result.unusedState).toHaveLength(0);
});
