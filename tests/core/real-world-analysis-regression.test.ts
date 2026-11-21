import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, truncateSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { traceStateTool } from '../../src/tools/trace-state';
import { getDownwardComponentTree } from '../../src/engine/graph/downward-traversal';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { extractTemplateExpressions } from '../../src/engine/template';
import { extractComponentContract } from '../../src/engine/contract';
import { queryFileStateDeps, queryStateImpact } from '../../src/engine/storage/state-impact';
import { scanNextAppRouter } from '../../src/engine/routing/next';
import { extractApiContractsFromCode } from '../../src/engine/api-contract';

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync('/tmp/strata-analysis-regression-');
  roots.push(root);
  put(root, 'package.json', JSON.stringify({ dependencies: { vue: '3', react: '19' } }));
  return root;
}
function put(root: string, file: string, content: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  closeAllDatabases();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('component boundaries and API audit associate options with each outbound HTTP call', async () => {
  const root = workspace();
  const code = [
    '<template><button @click="fetch(\'/api/template\')">Run</button></template>',
    '<script setup lang="ts">',
    '  fetch("/api/read"); fetch("/api/write", { method: "POST", body: JSON.stringify({ title: "new" }) });',
    '  useFetch(`/api/items/${id}`, { method: "PATCH", body: { enabled: true } });',
    '  axios.head("/api/headers");',
    '</script>',
  ].join('\n');
  const file = put(root, 'Calls.vue', code);
  const audit = extractApiContractsFromCode(code, file);
  const boundaries = (await extractComponentContract(file, code, { workspaceRoot: root })).boundaryContracts!;
  expect(audit.map(item => [item.method, item.endpoint])).toEqual([
    ['GET', '/api/template'], ['GET', '/api/read'], ['POST', '/api/write'],
    ['PATCH', '/api/items/:id'], ['HEAD', '/api/headers'],
  ]);
  expect(boundaries.map(item => [item.method, item.targetEndpoint])).toEqual([
    ['GET', '/api/template'], ['GET', '/api/read'], ['POST', '/api/write'],
    ['PATCH', '/api/items/${id}'], ['UNKNOWN', '/api/headers'],
  ]);
  expect(boundaries.map(item => item.loc)).toEqual(audit.map(({ line, column }) => ({ line, column })));
  expect(audit[1].line).toBe(audit[2].line);
  expect(audit[1].column).toBeLessThan(audit[2].column);
  expect(boundaries[2].payloadKeys).toEqual(['title']);
  expect(boundaries[3]).toMatchObject({ endpointSource: 'template-literal', payloadKeys: ['enabled'] });
});

test('TanStack mutation only consumes the call in its own mutation function', async () => {
  const root = workspace();
  const code = 'const m = useMutation({ mutationFn: () => axios.post("/api/items", { name }), onMutate: () => {} }); axios.get("/api/items");';
  const file = put(root, 'Mutation.tsx', code);
  const result = await extractComponentContract(file, code, { workspaceRoot: root });
  expect(result.boundaryContracts).toMatchObject([
    { boundaryType: 'tanstack-query', method: 'POST', targetEndpoint: '/api/items', optimisticUpdate: true, payloadKeys: ['name'] },
    { boundaryType: 'axios', method: 'GET', targetEndpoint: '/api/items' },
  ]);
});

test('outbound calls from an aliased composable retain the original call coordinates', async () => {
  const root = workspace();
  const hookCode = 'export const useCalls = () => { fetch("/api/read"); fetch("/api/write", { method: "POST" }); };';
  const hook = put(root, 'useCalls.ts', hookCode);
  const viewCode = 'import { useCalls as useRequests } from "./useCalls"; export function View() { useRequests(); return <div />; }';
  const view = put(root, 'View.tsx', viewCode);
  const direct = extractApiContractsFromCode(hookCode, hook);
  const contract = await extractComponentContract(view, viewCode, { workspaceRoot: root });
  expect(contract.boundaryContracts?.map(({ method, targetEndpoint, loc, source, viaComposable }) =>
    ({ method, targetEndpoint, loc, source, viaComposable }))).toEqual(
    direct.map(({ method, endpoint, line, column }) => ({
      method, targetEndpoint: endpoint, loc: { line, column }, source: 'imported-composable', viaComposable: 'useRequests',
    })),
  );
});

test.each([
  ["import {AuthShellSimple} from './components/auth-shell';", '<AuthShellSimple/>'],
  ["import {AuthShellSimple as Shell} from './components/auth-shell';", '<Shell/>'],
  ["import * as Auth from './components/auth-shell';", '<Auth.AuthShellSimple/>'],
  ["import {PublicShell as Shell} from './components';", '<Shell/>'],
])('dead-components follows rendered named imports: %s', async (binding, jsx) => {
  const root = workspace();
  put(root, 'src/components/auth-shell.tsx', 'export function AuthShellSimple(){return <section/>} export function Other(){return <aside/>}');
  put(root, 'src/components/index.ts', "export {AuthShellSimple as PublicShell} from './auth-shell';");
  put(root, 'src/components/import-only.tsx', 'export function ImportedOnly(){return <p/>}');
  put(root, 'src/Login.tsx', `${binding}\nimport {ImportedOnly} from './components/import-only';\nexport function Login(){return ${jsx}}`);
  const response = await auditFrontendTool.handler({ target_path: root, target: 'dead-components', format: 'json' });
  expect(response.isError).not.toBe(true);
  const unused = (response.structuredContent as any).unusedComponents.map((c: any) => c.fileName);
  expect(unused).not.toContain('auth-shell.tsx');
  expect(unused).toContain('import-only.tsx');
});

test('a shadowed JSX import does not make a named-export module live', async () => {
  const root = workspace();
  put(root, 'src/auth-shell.tsx', 'export function AuthShellSimple(){return <p/>}');
  put(root, 'src/Other.tsx', "import {AuthShellSimple as Shell} from './auth-shell'; export function Other({Shell}){return <Shell/>}");
  const response = await auditFrontendTool.handler({ target_path: root, target: 'dead-components', format: 'json' });
  expect((response.structuredContent as any).unusedComponents.map((c: any) => c.fileName)).toContain('auth-shell.tsx');
});

const templates: Record<string, { template: string; role: 'reader' | 'mutator' }> = {
  Sidebar: { template: '<button @click="ui.toggle()">{{ui.open}}</button>', role: 'mutator' },
  Reader: { template: '<p>{{ui.open}}</p>', role: 'reader' },
  Getter: { template: '<p>{{ui.getOpen()}}</p>', role: 'reader' },
  Compound: { template: '<button @click="ui.count += 1">Add</button>', role: 'mutator' },
  Logical: { template: '<button @click="ui.open ||= true">Open</button>', role: 'mutator' },
  Nested: { template: '<button @click="ui.settings.count *= 2">Double</button>', role: 'mutator' },
  Model: { template: '<input v-model="ui.open"/>', role: 'mutator' },
  BareAction: { template: '<button @click="ui.toggle">Toggle</button>', role: 'mutator' },
  BindMethod: { template: '<Child :handler="ui.toggle"/>', role: 'reader' },
  Mixed: { template: '<button @click="ui.getOpen(); ui.toggle()">Toggle</button>', role: 'mutator' },
};
test.each(['consumers', 'both'])('depth 1 %s preserves template reader/mutator roles and filters', async direction => {
  const root = workspace();
  put(root, 'src/stores/ui.ts', "export const useUiStore = defineStore('ui', {});");
  for (const [name, { template }] of Object.entries(templates)) {
    put(root, `src/${name}.vue`, `<script setup>\nimport {useUiStore} from './stores/ui';\nconst ui = useUiStore();\n</script>\n<template>\n${template}\n</template>`);
  }
  getWorkspaceDatabase(root, { create: true });
  for (const role of ['all', 'mutators', 'readers']) {
    const response = await traceStateTool.handler({ target_path: root, identifier: 'useUiStore', depth: 1, direction, role, format: 'json', max_bytes: 256000 });
    expect(response.isError).not.toBe(true);
    const consumers = (response.structuredContent as any).consumers;
    const expected = Object.entries(templates).filter(([,value]) => role === 'all' || value.role === (role === 'mutators' ? 'mutator' : 'reader'));
    expect(consumers).toHaveLength(expected.length);
    for (const [name, value] of expected) {
      const consumer = consumers.find((c: any) => basename(c.path ?? c.filePath) === `${name}.vue`);
      expect(consumer?.role).toBe(value.role);
      if (direction === 'consumers' && value.role === 'mutator') expect(consumer.lineNumber).toBe(6);
    }
  }
});

test('template extraction retains directive semantics without changing original expressions', () => {
  const result = extractTemplateExpressions('<input v-model="ui.open" @change="ui.toggle" :value="ui.value"/>{{ui.count}}');
  expect(result.map(e => [e.content, e.directive])).toEqual([
    ['ui.open', 'model'], ['ui.toggle', 'on'], ['ui.value', 'bind'], ['ui.count', undefined],
  ]);
});

test('destructured action aliases and v-model keep their original template coordinates', () => {
  const content = `<script setup>\nconst { toggle: flip, open } = useUiStore();\n</script>\n<template>\n<button @click="flip">Flip</button>\n<input v-model="open"/>\n</template>`;
  const result = extractStateDependencies(content, 'vue');
  expect(result.items?.filter(i => i.accessMode === 'write').map(i => i.lineNumber)).toEqual([5, 6]);
});

test('multiline directive whitespace preserves the actual write line', () => {
  const content = '<script setup>const ui=useUiStore()</script>\n<template><input v-model="\n  ui.open\n"/></template>';
  const result = extractStateDependencies(content, 'vue');
  expect(result.items?.filter(i => i.accessMode === 'write').map(i => i.lineNumber)).toEqual([3]);
});

test('Vue loop bindings shadow stores inside the loop while the iterable and siblings still use the store', async () => {
  const root = workspace();
  put(root, 'src/Loop.vue', `<script setup>
const cart = useCartStore();
</script>
<template>
<div v-for="({ cart }, key, index) in cart.rows" :key="key">
  <button @click="cart.clear()">{{ cart.open }}</button>
  <span v-for="row in cart.children">{{ cart.child }}</span>
</div>
</template>`);
  put(root, 'src/Sidebar.vue', `<script setup>
const cart = useCartStore();
</script>
<template>
<div v-for="cart in cart.rows"><button @click="cart.clear">Local</button></div>
<button @click="cart.reset">Reset store</button>
</template>`);
  getWorkspaceDatabase(root, { create: true });
  const result = await queryStateImpact(root, 'useCartStore');
  expect(result.readers?.map(row => [basename(row.path), row.accessedProperties])).toEqual([['Loop.vue', ['rows']]]);
  expect(result.mutators?.map(row => [basename(row.path), row.lineNumber, row.actionsCalled])).toEqual([
    ['Sidebar.vue', 6, ['cart.reset']],
  ]);
});

test('Nuxt literal useState keys carry script and template mutations through the state query', async () => {
  const root = workspace();
  put(root, 'package.json', JSON.stringify({ dependencies: { nuxt: '4' } }));
  const cases = {
    Reader: ['<p>{{ total }}</p>', 'reader', 2],
    Script: ['<p/>', 'mutator', 3],
    Template: ['<button @click="total++">Add</button>', 'mutator', 6],
    Loop: ['<button v-for="total in rows" @click="total++">Local</button>', 'reader', 2],
    Shadow: ['<p/>', 'reader', 2],
  } as const;
  for (const [name, [template]] of Object.entries(cases)) {
    put(root, `app/components/${name}.vue`, [
      '<script setup>',
      "const total = useState('checkout-count', () => 0);",
      name === 'Script' ? 'function increment() { ++total.value; }'
        : name === 'Shadow' ? 'function reset(total: { value: number }) { total.value = 0; }' : '',
      '</script>',
      '<template>',
      template,
      '</template>',
    ].join('\n'));
  }
  getWorkspaceDatabase(root, { create: true });
  const result = await queryStateImpact(root, 'checkout-count');
  expect(result.totalConsumers).toBe(5);
  for (const [name, [, role, lineNumber]] of Object.entries(cases)) {
    expect(result.consumers.find(row => basename(row.path) === `${name}.vue`)).toMatchObject({ role, lineNumber });
  }
});

test('React direct store selector attributes only the selected action invocation', async () => {
  const root = workspace();
  put(root, 'src/Cart.tsx', `import { useCartStore } from './cart';
const run = useCartStore(state => state.clear);
const count = useCartStore(state => state.count);
function local(run: () => void) { run(); }
export function Cart() {
  return <button onClick={() => run()}>{count}</button>;
}`);
  put(root, 'src/Reader.tsx', `import { useCartStore } from './cart';
const count = useCartStore(state => state.count);
export function Reader() { return <p>{count}</p>; }`);
  getWorkspaceDatabase(root, { create: true });
  const result = await queryStateImpact(root, 'useCartStore');
  expect(result.mutators?.map(row => [basename(row.path), row.lineNumber, row.actionsCalled])).toEqual([
    ['Cart.tsx', 6, ['return <button onClick={() => run()}>{count}</button>;']],
  ]);
  expect(result.readers?.map(row => basename(row.path))).toEqual(['Reader.tsx']);
});

test('Next App Router ignores dotted helpers in route discovery and layout chains', async () => {
  const root = workspace();
  const layout = put(root, 'app/layout.tsx', 'export default function Layout() { return null; }');
  const page = put(root, 'app/checkout/page.tsx', 'export default function Page() { return null; }');
  const handler = put(root, 'app/api/status/route.ts', 'export function GET() {}');
  put(root, 'app/checkout/layout.helpers.ts', 'export const revalidate = 1;');
  put(root, 'app/helpers/page.helpers.ts', 'export function helper() {}');
  put(root, 'app/api/helpers/route.helpers.ts', 'export function helper() {}');
  const routes = await scanNextAppRouter(join(root, 'app'));
  expect(routes.map(route => route.filePath).sort()).toEqual([layout, page, handler].sort());
  expect(routes.find(route => route.filePath === page)?.layouts).toEqual([layout]);
});

test('state queries select the same source observation for role, line and snippet', async () => {
  const root = workspace();
  const path = put(root, 'src/Sidebar.vue', [
    '<script setup>',
    'const ui = useUiStore();',
    'const status = useStatusStore();',
    'watch(() => status.ready, () => {});',
    '</script>',
    '<template>',
    '  <button @click="ui.toggle">{{ ui.open }}</button>',
    '  <button @click="ui.reset">Reset</button>',
    '</template>',
  ].join('\n'));
  getWorkspaceDatabase(root, { create: true });
  const ui = (await queryStateImpact(root, 'useUiStore')).consumers[0];
  const status = (await queryStateImpact(root, 'useStatusStore', 'all', { skipSync: true })).consumers[0];
  const byFile = await queryFileStateDeps(root, path, 'all', { skipSync: true });
  const uiEvidence = { role: 'mutator', accessMode: 'write', lineNumber: 7, usageSnippet: 'ui.toggle' };
  const statusEvidence = { role: 'reader', accessMode: 'watch', lineNumber: 4, usageSnippet: 'watch(() => status.ready, () => {});' };
  expect(ui).toMatchObject(uiEvidence);
  expect(ui.actionsCalled).toEqual(['ui.toggle', 'ui.reset']);
  expect(status).toMatchObject(statusEvidence);
  expect(byFile.dependencies.find(item => item.identifier === 'useUiStore')).toMatchObject(uiEvidence);
  expect(byFile.dependencies.find(item => item.identifier === 'useStatusStore')).toMatchObject(statusEvidence);
});

test('imported composable boundaries follow lexical bindings in React and Vue script blocks', async () => {
  const root = workspace();
  const hook = put(root, 'src/useOrders.ts', `const useOrders = () => axios.get('/api/orders');
export { useOrders };
export default useOrders;`);
  const namedImport = "import { useOrders as listOrders } from './useOrders';";
  const shadow = 'function unrelated(listOrders: () => void) { listOrders(); }';
  const react = put(root, 'src/Orders.tsx', `${namedImport}
${shadow}
export function Orders() { listOrders(); return <p/>; }`);
  const vue = put(root, 'src/Orders.vue', `<script lang="ts">import useOrders from './useOrders';</script>
<script setup lang="ts">
function unrelated(useOrders: () => void) { useOrders(); }
useOrders();
</script><template><p/></template>`);
  for (const [file, localName] of [[react, 'listOrders'], [vue, 'useOrders']]) {
    const contract = await extractComponentContract(file, { workspaceRoot: root });
    expect(contract.boundaryContracts).toMatchObject([
      { targetEndpoint: '/api/orders', source: 'imported-composable', viaComposable: localName },
    ]);
    expect(contract.dependencies).toContainEqual(expect.objectContaining({ path: hook }));
  }
  const onlyShadowed = await extractComponentContract(react, `${namedImport}\n${shadow}`, { workspaceRoot: root });
  expect(onlyShadowed.boundaryContracts).toBeUndefined();
});

test('an unreadable composable reports partial coverage and keeps other API boundaries', async () => {
  const root = workspace();
  const largeHook = put(root, 'src/useLarge.ts', '');
  truncateSync(largeHook, 8 * 1024 * 1024 + 1);
  put(root, 'src/useOrders.ts', "export function useOrders() { return axios.get('/api/orders'); }");
  const file = put(root, 'src/Orders.tsx', `import { useLarge } from './useLarge';
import { useOrders } from './useOrders';
export function Orders() { useLarge(); useOrders(); return <p/>; }`);
  const contract = await extractComponentContract(file, { workspaceRoot: root });
  expect(contract.boundaryDiagnostics).toEqual([
    { code: 'IMPORTED_COMPOSABLE_READ_FAILED', reason: expect.stringContaining('SOURCE_TOO_LARGE') },
  ]);
  expect(contract.boundaryContracts).toMatchObject([{ targetEndpoint: '/api/orders' }]);
});

function contextFixture(root: string, hookImport: string, extra = '') {
  put(root, 'src/context.ts', "import {createContext} from 'react'; export const ThemeContext=createContext(null);");
  put(root, 'src/Wrapped.tsx', `${hookImport}\nexport function Wrapped(){\nconst theme = useTheme();\nreturn <p>{theme}</p>;\n}\n${extra}`);
  return put(root, 'src/App.tsx', "import {ThemeContext} from './context'; import {Wrapped} from './Wrapped'; export function App(){return <ThemeContext.Provider value='dark'><Wrapped/></ThemeContext.Provider>}");
}
test.each([
  "import {useTheme} from './hook';",
  "import {usePalette as useTheme} from './barrel';",
  "import useTheme from './default-hook';",
])('context graph resolves hook wrappers: %s', async binding => {
  const root = workspace();
  put(root, 'src/hook.ts', "import {useContext as read} from 'react'; import {ThemeContext as Palette} from './context'; export const useTheme = () => read(Palette);");
  put(root, 'src/barrel.ts', "export {useTheme as usePalette} from './hook';");
  put(root, 'src/default-hook.ts', "export {useTheme as default} from './hook';");
  const entryPath = contextFixture(root, binding);
  const tree = await getDownwardComponentTree({ entryPath });
  const relation = tree.contextGraph?.relations.find(r => r.consumer.component === 'Wrapped.tsx');
  expect(relation?.key).toBe('ThemeContext');
  expect(relation?.consumer.line).toBe(3);
  expect(relation?.consumer.evidence?.method).toBe('react-hook-wrapper');
  expect(relation?.isCoveredInTree).toBe(true);
  expect(tree.contextGraph?.danglingConsumers).toEqual([]);
});

test('context graph follows local and nested hooks, skips shadowed imports and unused nested functions', async () => {
  const root = workspace();
  put(root, 'src/hook.ts', `import {useContext} from 'react'; import {ThemeContext} from './context';
function useInner(){return useContext(ThemeContext)}
export function useTheme(){function unused(){return useContext(UnrelatedContext)} return useInner()}`);
  const entryPath = contextFixture(root, "import {useTheme} from './hook';", 'function Shadow({useTheme}) {return useTheme()}');
  const tree = await getDownwardComponentTree({ entryPath });
  const consumers = tree.contextGraph?.consumers.filter(c => c.component === 'Wrapped.tsx');
  expect(consumers?.map(c => [c.key, c.line])).toEqual([['ThemeContext', 3]]);
});

test('cyclic hook imports terminate and a new query reads changed hook dependencies', async () => {
  const root = workspace();
  put(root, 'src/hook.ts', "import {useLoop} from './loop'; export function useTheme(){return useLoop()}");
  put(root, 'src/loop.ts', "import {useTheme} from './hook'; export function useLoop(){return useTheme()}");
  const entryPath = contextFixture(root, "import {useTheme} from './hook';");
  const before = await getDownwardComponentTree({ entryPath });
  expect(before.contextGraph?.consumers.some(c => c.component === 'Wrapped.tsx')).toBe(false);
  put(root, 'src/loop.ts', "import {useContext} from 'react'; import {ThemeContext} from './context'; export function useLoop(){return useContext(ThemeContext)}");
  const after = await getDownwardComponentTree({ entryPath });
  expect(after.contextGraph?.relations.some(r => r.key === 'ThemeContext' && r.consumer.component === 'Wrapped.tsx' && r.isCoveredInTree)).toBe(true);
});
