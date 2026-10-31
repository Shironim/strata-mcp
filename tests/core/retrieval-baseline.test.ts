import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { mapSourceFile } from '../../src/engine/source-map';
import { readSourceRef } from '../../src/engine/source-file';
import type { ComponentContract } from '../../src/types';

let root = '';
afterEach(async () => {
  closeAllDatabases();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

// Manual oracle: one rendered import, one template region, one required prop.
const child = '<script setup lang="ts">\ndefineProps<{ title: string }>();\n</script>\n<template><h1>{{ title }}</h1></template>\n';
const app = '<script setup lang="ts">\nimport Child from "./Child.vue";\n</script>\n<template><Child title="café 🙂" /></template>\n';

async function fixture() {
  root = await mkdtemp('/tmp/strata-retrieval-baseline-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'Child.vue'), child);
  await writeFile(join(root, 'App.vue'), app);
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
}

function semanticGraph() {
  const db = getWorkspaceDatabase(root, { enableWatcher: false });
  // Remove only database identity and workspace location, retaining all payload fields.
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll(root, '<workspace>');
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
  };
  return normalize({
    files: db.query('SELECT path, framework, content_hash FROM files ORDER BY path').all(),
    components: db.query('SELECT f.path, c.name, c.contract_json FROM components c JOIN files f ON f.id=c.file_id ORDER BY f.path,c.name').all(),
    edges: db.query('SELECT p.path AS parent, c.path AS child, e.import_type, e.is_rendered, e.payload_json FROM edges e JOIN files p ON p.id=e.parent_file_id JOIN files c ON c.id=e.child_file_id ORDER BY p.path,c.path,e.import_type').all(),
    state: db.query('SELECT f.path,s.kind,s.identifier,s.access_mode,s.line_number,s.usage_snippet FROM state_deps s JOIN files f ON f.id=s.file_id ORDER BY f.path,s.kind,s.identifier,s.line_number').all(),
  });
}

test('Vue retrieval has manually expected rendered edge and exact source region', async () => {
  await fixture();
  await syncWorkspace(root);
  const db = getWorkspaceDatabase(root);
  const edges = db.query('SELECT p.path AS parent,c.path AS child,e.is_rendered FROM edges e JOIN files p ON p.id=e.parent_file_id JOIN files c ON c.id=e.child_file_id').all() as {parent: string; child: string; is_rendered: number}[];
  expect(edges.map(e => ({ parent: relative(root, e.parent), child: relative(root, e.child), rendered: e.is_rendered }))).toEqual([{ parent: 'App.vue', child: 'Child.vue', rendered: 1 }]);
  const map = await mapSourceFile(join(root, 'App.vue'));
  const template = map.regions.find(r => r.name === 'template')!;
  expect(template).toBeDefined();
  expect(await readSourceRef(join(root, 'App.vue'), template.ref)).toBe('<Child title="café 🙂" />');
  expect(template.ref.startOffset).toBe(app.indexOf('<Child'));
  expect(template.ref.endOffset).toBe(app.indexOf('</template>'));
  expect(template.children?.[0].name).toBe('Child');
});

async function expectRestartAndColdRebuild(incremental: unknown) {
  closeAllDatabases();
  expect(semanticGraph()).toEqual(incremental);
  closeAllDatabases();
  // Only the disposable fixture's index is removed; source stays identical.
  await rm(join(root, '.strata'), { recursive: true, force: true });
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);
  expect(semanticGraph()).toEqual(incremental);
}

async function expectTemplateRegion(file: string, source: string, expected: string) {
  const map = await mapSourceFile(join(root, file));
  const template = map.regions.find(region => region.name === 'template');
  expect(template).toBeDefined();
  expect(await readSourceRef(join(root, file), template!.ref)).toBe(expected);
  expect(template!.ref.startOffset).toBe(source.indexOf(expected));
  expect(template!.ref.endOffset).toBe(source.indexOf(expected) + expected.length);
}

function expectRenderedEdges(expected: { parent: string; child: string; rendered: number }[]) {
  const db = getWorkspaceDatabase(root, { enableWatcher: false });
  const edges = db.query('SELECT p.path AS parent,c.path AS child,e.is_rendered FROM edges e JOIN files p ON p.id=e.parent_file_id JOIN files c ON c.id=e.child_file_id ORDER BY p.path,c.path').all() as { parent: string; child: string; is_rendered: number }[];
  expect(edges.map(edge => ({ parent: relative(root, edge.parent), child: relative(root, edge.child), rendered: edge.is_rendered }))).toEqual(expected);
}

function storedContract(file: string): ComponentContract {
  const db = getWorkspaceDatabase(root, { enableWatcher: false });
  const row = db.query('SELECT c.contract_json FROM components c JOIN files f ON f.id=c.file_id WHERE f.path=?').get(join(root, file)) as { contract_json: string } | null;
  expect(row).not.toBeNull();
  return JSON.parse(row!.contract_json);
}

function expectProps(file: string, expected: { name: string; type: string; required: boolean }[]) {
  const props = storedContract(file).props.map(({ name, type, required }) => ({ name, type, required }));
  expect(props.sort((a, b) => a.name.localeCompare(b.name))).toEqual([...expected].sort((a, b) => a.name.localeCompare(b.name)));
}

test('incremental edits and restart agree with full rebuild without hiding semantic payloads', async () => {
  await fixture();
  expect((await syncWorkspace(root)).parserInvocations).toBe(2);
  expect((await syncWorkspace(root)).parserInvocations).toBe(0);
  for (const source of [child.replace('title: string', 'title: string; count?: number'), child.replace('<h1>', '<h2>').replace('</h1>', '</h2>')]) {
    await writeFile(join(root, 'Child.vue'), source);
    const stats = await syncWorkspace(root);
    expect(stats.modified).toBe(1);
    expect(stats.parserInvocations).toBe(2);
    const incremental = semanticGraph();
    await expectRestartAndColdRebuild(incremental);
  }
});

test('component create rename and delete match manual edge oracles and cold rebuilds', async () => {
  await fixture();
  await syncWorkspace(root);
  const originalEdge = { parent: 'App.vue', child: 'Child.vue', rendered: 1 };
  const extra = '<script setup lang="ts">\ndefineProps<{ count: number }>();\n</script>\n<template><p>{{ count }}</p></template>\n';
  const withExtra = app.replace('</script>', 'import Extra from "./Extra.vue";\n</script>').replace(' /></template>', ' /><Extra :count="1" /></template>');

  await writeFile(join(root, 'Extra.vue'), extra);
  await writeFile(join(root, 'App.vue'), withExtra);
  await syncWorkspace(root);
  expectRenderedEdges([originalEdge, { parent: 'App.vue', child: 'Extra.vue', rendered: 1 }]);
  await expectTemplateRegion('App.vue', withExtra, '<Child title="café 🙂" /><Extra :count="1" />');
  await expectRestartAndColdRebuild(semanticGraph());

  const renamed = withExtra.replaceAll('Extra', 'Renamed');
  await rename(join(root, 'Extra.vue'), join(root, 'Renamed.vue'));
  await writeFile(join(root, 'App.vue'), renamed);
  await syncWorkspace(root);
  expectRenderedEdges([originalEdge, { parent: 'App.vue', child: 'Renamed.vue', rendered: 1 }]);
  expect(getWorkspaceDatabase(root).query('SELECT path FROM files WHERE path=?').get(join(root, 'Extra.vue'))).toBeNull();
  await expectTemplateRegion('App.vue', renamed, '<Child title="café 🙂" /><Renamed :count="1" />');
  await expectRestartAndColdRebuild(semanticGraph());

  await rm(join(root, 'Renamed.vue'));
  await writeFile(join(root, 'App.vue'), app);
  await syncWorkspace(root);
  expectRenderedEdges([originalEdge]);
  expect(getWorkspaceDatabase(root).query('SELECT path FROM files WHERE path=?').get(join(root, 'Renamed.vue'))).toBeNull();
  await expectTemplateRegion('App.vue', app, '<Child title="café 🙂" />');
  await expectRestartAndColdRebuild(semanticGraph());
});

test('imported interface changes update an unchanged Vue consumer against a manual prop oracle', async () => {
  await fixture();
  const typedChild = child.replace('defineProps<{ title: string }>();', 'import type { Props } from "./types";\ndefineProps<Props>();');
  const typesPath = join(root, 'types.ts');
  await writeFile(join(root, 'Child.vue'), typedChild);
  await writeFile(typesPath, 'export interface Props { title: string; count?: number }\n');
  await syncWorkspace(root);
  expectProps('Child.vue', [
    { name: 'title', type: 'string', required: true },
    { name: 'count', type: 'number', required: false },
  ]);
  await expectRestartAndColdRebuild(semanticGraph());

  // Change only the external declaration: type, optionality, removal and addition.
  await writeFile(typesPath, 'export interface Props { title?: number; enabled: boolean }\n');
  await syncWorkspace(root);
  expect(await readFile(join(root, 'Child.vue'), 'utf8')).toBe(typedChild);
  expectProps('Child.vue', [
    { name: 'title', type: 'number', required: false },
    { name: 'enabled', type: 'boolean', required: true },
  ]);
  await expectTemplateRegion('Child.vue', typedChild, '<h1>{{ title }}</h1>');
  await expectRestartAndColdRebuild(semanticGraph());
  expectProps('Child.vue', [
    { name: 'title', type: 'number', required: false },
    { name: 'enabled', type: 'boolean', required: true },
  ]);
});

test('missing component resolution transitions retain unchanged caller and match cold graph rebuilds', async () => {
  await fixture();
  const caller = app.replace('./Child.vue', './Pending.vue').replaceAll('Child', 'Pending');
  await writeFile(join(root, 'App.vue'), caller);
  await syncWorkspace(root);
  // This oracle checks resolved graph membership only, not unresolved diagnostics.
  expectRenderedEdges([]);
  await expectRestartAndColdRebuild(semanticGraph());

  await writeFile(join(root, 'Pending.vue'), child);
  await syncWorkspace(root);
  expectRenderedEdges([{ parent: 'App.vue', child: 'Pending.vue', rendered: 1 }]);
  expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
  await expectRestartAndColdRebuild(semanticGraph());

  await rm(join(root, 'Pending.vue'));
  await syncWorkspace(root);
  expectRenderedEdges([]);
  expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
  await expectTemplateRegion('App.vue', caller, '<Pending title="café 🙂" />');
  await expectRestartAndColdRebuild(semanticGraph());
});

test('Vue alias config creation replacement and deletion match manual edges and cold rebuilds', async () => {
  await fixture();
  await mkdir(join(root, 'first'));
  await mkdir(join(root, 'second'));
  await writeFile(join(root, 'first', 'Child.vue'), child);
  await writeFile(join(root, 'second', 'Child.vue'), child.replace('title: string', 'title: string; enabled?: boolean'));
  const caller = app.replace('./Child.vue', '@/Child.vue');
  await writeFile(join(root, 'App.vue'), caller);
  await syncWorkspace(root);
  expectRenderedEdges([]);
  const configPath = join(root, 'tsconfig.json');
  for (const directory of ['first', 'second']) {
    await writeFile(configPath, JSON.stringify({ compilerOptions: { paths: { '@/*': [`${directory}/*`] } } }));
    const stats = await syncWorkspace(root);
    expect(stats.cacheHit).toBe(false);
    expectRenderedEdges([{ parent: 'App.vue', child: `${directory}/Child.vue`, rendered: 1 }]);
    expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
    await expectTemplateRegion('App.vue', caller, '<Child title="café 🙂" />');
    await expectRestartAndColdRebuild(semanticGraph());
  }
  await rm(configPath);
  expect((await syncWorkspace(root)).cacheHit).toBe(false);
  expectRenderedEdges([]);
  expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
  await expectRestartAndColdRebuild(semanticGraph());
});

test('Vue scoped component edits preserve outside caller edges and agree with a whole-workspace rebuild', async () => {
  await fixture();
  await mkdir(join(root, 'feature'));
  const target = join(root, 'feature', 'Child.vue');
  await writeFile(target, child);
  const caller = app.replace('./Child.vue', './feature/Child.vue');
  await writeFile(join(root, 'App.vue'), caller);
  await syncWorkspace(root);
  const expected = [{ parent: 'App.vue', child: 'feature/Child.vue', rendered: 1 }];
  expectRenderedEdges(expected);
  const updated = child.replace('title: string', 'title: string; count?: number');
  await writeFile(target, updated);
  const stats = await syncWorkspace(root, join(root, 'feature'));
  expect(stats.modified).toBe(1);
  expectRenderedEdges(expected);
  expectProps('feature/Child.vue', [
    { name: 'title', type: 'string', required: true },
    { name: 'count', type: 'number', required: false },
  ]);
  expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
  await expectTemplateRegion('feature/Child.vue', updated, '<h1>{{ title }}</h1>');
  await expectRestartAndColdRebuild(semanticGraph());
});

test('Vue barrel export replacement updates unchanged caller edges against a manual oracle', async () => {
  await fixture();
  await mkdir(join(root, 'components'));
  await writeFile(join(root, 'components', 'First.vue'), child);
  await writeFile(join(root, 'components', 'Second.vue'), child.replace('title: string', 'title?: string'));
  const caller = app.replace('import Child from "./Child.vue"', 'import { Child } from "./components/index"');
  await writeFile(join(root, 'App.vue'), caller);
  const barrel = join(root, 'components', 'index.ts');
  for (const target of ['First', 'Second']) {
    await writeFile(barrel, `export { default as Child } from './${target}.vue';\n`);
    await syncWorkspace(root);
    // The barrel source also imports/re-exports its target; rendered caller must point
    // at the actual component, not the index module or the previous export target.
    const db = getWorkspaceDatabase(root);
    const edges = db.query('SELECT c.path AS child,e.is_rendered FROM edges e JOIN files p ON p.id=e.parent_file_id JOIN files c ON c.id=e.child_file_id WHERE p.path=? ORDER BY c.path').all(join(root, 'App.vue')) as { child: string; is_rendered: number }[];
    expect(edges).toEqual([{ child: join(root, 'components', `${target}.vue`), is_rendered: 1 }]);
    expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe(caller);
    await expectRestartAndColdRebuild(semanticGraph());
  }
});

test('Vue cycle edge removal matches manual directed edges and cold rebuild', async () => {
  await fixture();
  const cyclicChild = '<script setup>import App from "./App.vue";</script><template><App/></template>';
  await writeFile(join(root, 'Child.vue'), cyclicChild);
  await syncWorkspace(root);
  expectRenderedEdges([
    { parent: 'App.vue', child: 'Child.vue', rendered: 1 },
    { parent: 'Child.vue', child: 'App.vue', rendered: 1 },
  ]);
  await expectRestartAndColdRebuild(semanticGraph());
  await writeFile(join(root, 'Child.vue'), child);
  await syncWorkspace(root);
  expectRenderedEdges([{ parent: 'App.vue', child: 'Child.vue', rendered: 1 }]);
  await expectRestartAndColdRebuild(semanticGraph());
});

test('scoped imported-type edits refresh an unchanged Vue dependent outside scope', async () => {
  await fixture();
  await mkdir(join(root, 'shared'));
  const typesPath = join(root, 'shared', 'types.ts');
  const typedChild = child.replace('defineProps<{ title: string }>();', 'import type { Props } from "./shared/types";\ndefineProps<Props>();');
  await writeFile(join(root, 'Child.vue'), typedChild);
  await writeFile(typesPath, 'export interface Props { title: string }\n');
  await syncWorkspace(root);
  expectProps('Child.vue', [{ name: 'title', type: 'string', required: true }]);
  await writeFile(typesPath, 'export interface Props { title?: number; enabled: boolean }\n');
  const scoped = await syncWorkspace(root, join(root, 'shared'));
  expect(scoped.scope).toEqual({ requested: join(root, 'shared'), effective: root, fallbackReason: 'DEPENDENCY_CLOSURE_UNVERIFIED' });
  expect(await readFile(join(root, 'Child.vue'), 'utf8')).toBe(typedChild);
  expectProps('Child.vue', [
    { name: 'title', type: 'number', required: false },
    { name: 'enabled', type: 'boolean', required: true },
  ]);
  await expectRestartAndColdRebuild(semanticGraph());
  const warm = await syncWorkspace(root, join(root, 'shared'));
  expect(warm.cacheHit).toBe(true);
  expect(warm.parserInvocations).toBe(0);
  expect(warm.scope).toEqual({ requested: join(root, 'shared'), effective: join(root, 'shared'), fallbackReason: null });

  await rm(typesPath);
  const removed = await syncWorkspace(root, join(root, 'shared'));
  expect(removed.scope?.fallbackReason).toBe('DEPENDENCY_CLOSURE_UNVERIFIED');
  expectProps('Child.vue', []);
  await expectRestartAndColdRebuild(semanticGraph());
  await writeFile(typesPath, 'export interface Props { title: string }\n');
  const created = await syncWorkspace(root, join(root, 'shared'));
  expect(created.scope?.fallbackReason).toBe('DEPENDENCY_CLOSURE_UNVERIFIED');
  expectProps('Child.vue', [{ name: 'title', type: 'string', required: true }]);
  await expectRestartAndColdRebuild(semanticGraph());
});
