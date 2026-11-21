import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findUnusedComponents } from '../../src/engine/audit';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { analyzePropImpact } from '../../src/engine/prop-impact';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { getComponentTree } from '../../src/engine/tree';

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'strata-component-relationships-'));
  try { await run(root); }
  finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
}

const vueCard = '<script setup lang="ts">defineProps<{label?: string}>()</script><template><p /></template>';

function plan(root: string, componentPath: string) {
  return generatePatchPlan({ targetPath: root, componentPath, refactorType: 'rename_prop', oldName: 'label', newName: 'heading' });
}

test('JSX rename and prop impact resolve a named import alias at each use site', async () => withWorkspace(async root => {
  await writeFile(join(root, 'package.json'), '{"dependencies":{"react":"19"}}');
  const target = join(root, 'Button.tsx');
  const parent = join(root, 'Parent.tsx');
  await writeFile(target, 'export function Button(props: {label: string}) { return <p>{props.label}</p> }');
  await writeFile(join(root, 'index.ts'), 'export { Button } from "./Button";');
  const content = [
    'import { Button as Card } from "./index";',
    'export function Real() { return <Card label="real" />; }',
    'export function Shadow(Card: typeof import("./Button").Button) { return <Card label="local" />; }',
  ].join('\n');
  await writeFile(parent, content);

  const assertUsage = async () => {
    const patches = (await plan(root, target)).patches;
    expect(patches.map(patch => [patch.file, patch.line, patch.oldSnippet])).toEqual([[parent, 2, 'label']]);
    const impact = await analyzePropImpact({
      target, workspace: root, props: [{ name: 'label', type: 'string', required: true }], detail: 'full',
    });
    const usage = impact.props[0];
    expect(usage.confirmedUsageCount).toBe(1);
    expect(usage.usages!.map(item => content.slice(item.sourceRef.startOffset, item.sourceRef.endOffset))).toEqual(['label="real"']);
  };
  await assertUsage();
  const db = getWorkspaceDatabase(root, { create: true });
  await syncWorkspace(root);
  await assertUsage();
  await writeFile(parent, content.split('\n').filter(line => !line.includes('function Real')).join('\n'));
  expect((await plan(root, target)).patches).toEqual([]);
  expect(db.query('SELECT e.is_rendered FROM edges e JOIN files p ON p.id = e.parent_file_id WHERE p.path = ?').all(parent))
    .toEqual([{ is_rendered: 0 }]);
  const down = await getComponentTree({ targetPath: root, entryPath: parent });
  expect(down.root.children).toEqual([]);
  const audit = await findUnusedComponents({ targetPath: root, excludePages: false });
  expect(audit.unusedComponents.map(component => component.filePath)).toContain(target);
}));

test('Nuxt source and SQLite preserve auto-import patch coverage through catalog changes', async () => withWorkspace(async root => {
  await writeFile(join(root, 'package.json'), '{"dependencies":{"nuxt":"3"}}');
  const target = join(root, 'components/Card.vue');
  const auto = join(root, 'Auto.vue');
  const explicit = join(root, 'Explicit.vue');
  const collision = join(root, 'other/Card.vue');
  for (const file of [target, collision]) await mkdir(dirname(file), { recursive: true });
  await writeFile(target, vueCard);
  await writeFile(auto, '<template><Card label="auto" /><template v-for="Card in values"><Card label="local" /></template></template>');
  await writeFile(explicit, '<script setup>import Card from "./components/Card.vue";</script><template><Card label="explicit" /></template>');

  async function consumers() {
    const { root: tree } = await getComponentTree({ targetPath: root, entryPath: target, direction: 'upward', maxDepth: 1 });
    return tree.children.map(node => [node.filePath, node.isAutoImported ?? false]);
  }
  const both = [[auto, true], [explicit, false]];
  expect(await consumers()).toEqual(both);
  expect((await plan(root, target)).patches.map(patch => patch.file)).toEqual([auto, explicit]);
  expect((await plan(root, target)).patches.map(patch => patch.oldSnippet)).toEqual(['label="auto"', 'label="explicit"']);
  getWorkspaceDatabase(root, { create: true });
  await syncWorkspace(root);
  expect(await consumers()).toEqual(both);
  expect((await plan(root, target)).patches.map(patch => patch.file)).toEqual([auto, explicit]);
  expect((await syncWorkspace(root)).cacheHit).toBe(true);

  await writeFile(collision, vueCard);
  await syncWorkspace(root);
  expect(await consumers()).toEqual([[explicit, false]]);
  expect((await plan(root, target)).patches.map(patch => patch.file)).toEqual([explicit]);
  const down = await getComponentTree({ targetPath: root, entryPath: auto });
  expect(down.root.children).toEqual([]);
  expect(down.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AMBIGUOUS_COMPONENT' })]));
  await syncWorkspace(root, undefined, undefined, { rebuild: true });
  expect(await consumers()).toEqual([[explicit, false]]);

  const renamed = join(root, 'other/OtherCard.vue');
  await rename(collision, renamed);
  expect(await consumers()).toEqual(both);
  await syncWorkspace(root, undefined, undefined, { rebuild: true });
  expect(await consumers()).toEqual(both);
  await rename(renamed, collision);
  expect(await consumers()).toEqual([[explicit, false]]);
  await rm(collision);
  expect(await consumers()).toEqual(both);
}));

test('auto-import collisions stay within applications and explicit alias maps use source resolution', async () => withWorkspace(async root => {
  await writeFile(join(root, 'package.json'), '{"dependencies":{"nuxt":"3"}}');
  const appA = join(root, 'apps/a');
  const appB = join(root, 'apps/b');
  await mkdir(appA, { recursive: true });
  await mkdir(appB, { recursive: true });
  const target = join(appB, 'Card.vue');
  const auto = join(appB, 'Auto.vue');
  const explicit = join(appA, 'Explicit.vue');
  await writeFile(join(appA, 'Card.vue'), vueCard);
  await writeFile(target, vueCard);
  await writeFile(auto, '<template><Card/></template>');
  await writeFile(explicit, '<script setup>import Alias from "@/Card.vue";</script><template><Alias/></template>');
  getWorkspaceDatabase(root, { create: true });
  await syncWorkspace(root);
  const query = { targetPath: root, entryPath: target, direction: 'upward' as const, maxDepth: 1 };
  expect((await getComponentTree(query)).root.children.map(node => node.filePath)).toEqual([auto]);
  const aliasMap = { '@/': './apps/b/' };
  expect((await getComponentTree({ ...query, aliasMap })).root.children.map(node => node.filePath)).toEqual([explicit, auto]);
  expect((await getComponentTree({ targetPath: root, entryPath: explicit, aliasMap })).root.children.map(node => node.filePath)).toEqual([target]);
}));
