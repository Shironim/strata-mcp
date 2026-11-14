import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { traceStateTool } from '../../src/tools/trace-state';
import { getDownwardComponentTree } from '../../src/engine/graph/downward-traversal';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { extractTemplateExpressions } from '../../src/engine/template';

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
