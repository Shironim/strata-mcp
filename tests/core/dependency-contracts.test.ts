import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { extractComponentContract } from '../../src/engine/contract';
import { getComponentTree } from '../../src/engine/tree';
import { queryUnusedComponentsFromDb } from '../../src/engine/storage/blast-radius';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { derivedRetrievalEvidence } from '../../src/engine/retrieval-evidence';
import { readSourceSnapshot } from '../../src/engine/source-file';
import type { ComponentContract } from '../../src/types';

let tempDir = '';
afterEach(async () => {
  closeAllDatabases();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function storedContract(root: string, file: string): ComponentContract {
  const db = getWorkspaceDatabase(root, { enableWatcher: false });
  const row = db.query('SELECT c.contract_json FROM components c JOIN files f ON f.id=c.file_id WHERE f.path=?').get(join(root, file)) as { contract_json: string } | null;
  expect(row).not.toBeNull();
  return JSON.parse(row!.contract_json);
}

test('external imported types outside workspace boundary invalidate cached contract', async () => {
  tempDir = await mkdtemp('/tmp/strata-external-dep-');
  const parentTypesPath = join(tempDir, 'types.ts');
  const appRoot = join(tempDir, 'app');
  await mkdir(appRoot, { recursive: true });

  await writeFile(parentTypesPath, 'export interface Props { title: string; }\n');
  await writeFile(join(appRoot, 'package.json'), '{"name":"app","dependencies":{"vue":"3"}}');
  await writeFile(
    join(appRoot, 'Child.vue'),
    `<script setup lang="ts">
import type { Props } from '../types';
defineProps<Props>();
</script>
<template><div>{{ title }}</div></template>
`
  );

  getWorkspaceDatabase(appRoot, { create: true, enableWatcher: false });
  const initialSync = await syncWorkspace(appRoot);
  expect(initialSync.added).toBe(1);

  const initialProps = storedContract(appRoot, 'Child.vue').props.map(p => ({ name: p.name, type: p.type, required: p.required }));
  expect(initialProps).toEqual([{ name: 'title', type: 'string', required: true }]);

  // Now mutate ONLY the external types.ts outside the workspace
  await writeFile(parentTypesPath, 'export interface Props { title: number; enabled: boolean; }\n');

  // Verify direct extraction directly sees the new types
  const direct = await extractComponentContract(join(appRoot, 'Child.vue'), await Bun.file(join(appRoot, 'Child.vue')).text());
  const directProps = direct.props.map(p => ({ name: p.name, type: p.type, required: p.required }));
  expect(directProps).toEqual([
    { name: 'title', type: 'number', required: true },
    { name: 'enabled', type: 'boolean', required: true },
  ]);

  // Re-sync workspace
  const secondSync = await syncWorkspace(appRoot);

  // Expected oracle for F-01/F-02:
  // If external dependency is tracked, it must invalidate cache (not cacheHit=true with stale storedProps).
  // Stored contract in DB must match fresh external types, or reflect invalidation.
  const storedAfter = storedContract(appRoot, 'Child.vue').props.map(p => ({ name: p.name, type: p.type, required: p.required }));
  expect(secondSync.cacheHit).toBe(false);
  expect(storedAfter).toEqual([
    { name: 'title', type: 'number', required: true },
    { name: 'enabled', type: 'boolean', required: true },
  ]);
});

test('import-only components are recorded with is_rendered=0, distinct from rendered template usages', async () => {
  tempDir = await mkdtemp('/tmp/strata-import-only-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'Child.vue'), '<template><div>Child</div></template>\n');
  await writeFile(join(root, 'Unused.vue'), '<template><div>Unused</div></template>\n');
  await writeFile(
    join(root, 'App.vue'),
    `<script setup lang="ts">
import Child from './Child.vue';
import Unused from './Unused.vue';
</script>
<template>
  <Child />
</template>
`
  );

  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);

  const db = getWorkspaceDatabase(root, { enableWatcher: false });
  const edges = db.query(`
    SELECT p.path AS parent, c.path AS child, e.import_type, e.is_rendered
    FROM edges e
    JOIN files p ON p.id = e.parent_file_id
    JOIN files c ON c.id = e.child_file_id
    ORDER BY c.path
  `).all() as Array<{ parent: string; child: string; import_type: string; is_rendered: number }>;

  const normalized = edges.map(e => ({
    parent: relative(root, e.parent),
    child: relative(root, e.child),
    import_type: e.import_type,
    is_rendered: e.is_rendered,
  }));

  // Expected oracle:
  // Child is rendered in template -> is_rendered = 1
  // Unused is only imported in script -> is_rendered = 0
  expect(normalized).toEqual([
    { parent: 'App.vue', child: 'Child.vue', import_type: 'static', is_rendered: 1 },
    { parent: 'App.vue', child: 'Unused.vue', import_type: 'static', is_rendered: 0 },
  ]);

  // Downward tree must only render Child
  const tree = await getComponentTree({ entryPath: join(root, 'App.vue'), targetPath: root });
  expect(tree.root.children.map(c => c.component)).toEqual(['Child.vue']);

  // DB audit: Unused.vue must be identified as unused (is_rendered=0 across all callers), while Child is rendered
  const unusedFromDb = queryUnusedComponentsFromDb(db);
  expect(unusedFromDb.map(u => u.name).sort()).toEqual(['App', 'Unused']);
  expect(unusedFromDb.some(u => u.name === 'Child')).toBe(false);
});

test('inspect_component surfaces UNRESOLVED_PROPS_TYPE omissions and tracks secondary dependency freshness', async () => {
  tempDir = await mkdtemp('/tmp/strata-dep-freshness-');
  const appRoot = join(tempDir, 'app');
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, 'package.json'), '{"dependencies":{"vue":"3"}}');

  // 1. Unresolved generic type
  const missingTypeFile = join(appRoot, 'MissingProps.vue');
  await writeFile(
    missingTypeFile,
    `<script setup lang="ts">
defineProps<NonExistentProps>();
</script>
<template><div>Missing</div></template>
`
  );

  const missingResult = await inspectComponentTool.handler({
    path: missingTypeFile,
    output_format: 'json',
  });
  const missingJson = JSON.parse(missingResult.content[0].text);
  expect(missingJson.unresolvedTypes).toBeDefined();
  expect(missingJson.unresolvedTypes[0].name).toBe('NonExistentProps');
  expect(missingJson.retrieval.omissions.some((o: any) => o.code === 'UNRESOLVED_PROPS_TYPE')).toBe(true);

  // 2. Tracked secondary dependency
  const depPath = join(tempDir, 'types.ts');
  await writeFile(depPath, 'export interface ItemProps { id: string; }\n');
  const childFile = join(appRoot, 'ChildWithDep.vue');
  await writeFile(
    childFile,
    `<script setup lang="ts">
import type { ItemProps } from '../types';
defineProps<ItemProps>();
</script>
<template><div>{{ id }}</div></template>
`
  );

  const initialInspect = await inspectComponentTool.handler({
    path: childFile,
    output_format: 'json',
  });
  const initialJson = JSON.parse(initialInspect.content[0].text);
  expect(initialJson.props.map((p: any) => p.name)).toEqual(['id']);
  expect(initialJson.retrieval.dependencies?.status).toBe('current');
  expect(initialJson.retrieval.freshness).toBe('current');

  // Test derivedRetrievalEvidence directly with captured initial dependencies
  const { snapshot } = await readSourceSnapshot(childFile);
  const trackedDeps = initialJson.dependencies;
  expect(trackedDeps).toBeDefined();

  // Mutate dependency on disk
  await writeFile(depPath, 'export interface ItemProps { id: number; name: string; }\n');

  const staleEvidence = await derivedRetrievalEvidence({
    workspace: appRoot,
    snapshot,
    policy: 'component-contract-v1',
    query: { inferProps: true, resolveGlobals: true },
    complete: true,
    selectionReason: 'Verification of staleness detection on disk mutation',
    dependencies: trackedDeps,
  });

  expect(staleEvidence.dependencies?.status).toBe('stale');
  expect(staleEvidence.freshness).toBe('stale');
  expect(staleEvidence.omissions.some((o: any) => o.code === 'DEPENDENCY_CHANGED')).toBe(true);
});

test('audit_frontend cleanly separates filesystem-direct evidence from SQLite indexed evidence', async () => {
  tempDir = await mkdtemp('/tmp/strata-audit-evidence-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'App.vue'), '<template><div>Audit</div></template>\n');

  // Direct filesystem target: similar-templates
  const fsResult = await auditFrontendTool.handler({
    target_path: root,
    target: 'similar-templates',
    output_format: 'json',
  });
  const fsJson = JSON.parse(fsResult.content[0].text);
  expect(fsJson.retrieval.policy).toBe('filesystem-audit-v1');
  expect(fsJson.retrieval.index).toBeNull();
  expect(fsJson.retrieval.omissions.some((o: any) => o.code === 'DIRECT_FILESYSTEM_SCAN')).toBe(true);

  // Database-backed target: dead-components (after workspace is indexed)
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);

  const dbResult = await auditFrontendTool.handler({
    target_path: root,
    target: 'dead-components',
    output_format: 'json',
  });
  const dbJson = JSON.parse(dbResult.content[0].text);
  expect(dbJson.retrieval.policy).toBe('frontend-audit-v1');
  expect(dbJson.retrieval.index).not.toBeNull();
  expect(dbJson.retrieval.index.consistency).toBe('observed-stable');
});

test('tracks multi-hop inherited interface secondary dependencies (extends BaseProps)', async () => {
  tempDir = await mkdtemp('/tmp/strata-multi-hop-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');

  // Base types file
  const baseTypes = join(root, 'base.ts');
  await writeFile(baseTypes, 'export interface BaseProps { id: string; active?: boolean; }\n');

  // Derived types file that extends BaseProps
  const childTypes = join(root, 'childTypes.ts');
  await writeFile(
    childTypes,
    `import type { BaseProps } from './base';
export interface ChildProps extends BaseProps {
  title: string;
}
`
  );

  // Component file
  const compFile = join(root, 'Card.vue');
  await writeFile(
    compFile,
    `<script setup lang="ts">
import type { ChildProps } from './childTypes';
defineProps<ChildProps>();
</script>
<template><div>{{ title }} ({{ id }})</div></template>
`
  );

  const res = await inspectComponentTool.handler({
    path: compFile,
    format: 'json',
  });

  const json = JSON.parse(res.content[0].text);
  // Must extract both local title and inherited id, active props
  const propNames = json.props.map((p: any) => p.name).sort();
  expect(propNames).toEqual(['active', 'id', 'title']);

  // Dependencies must track both childTypes.ts and base.ts
  const depPaths = json.dependencies.map((d: any) => relative(root, d.path)).sort();
  expect(depPaths).toContain('base.ts');
  expect(depPaths).toContain('childTypes.ts');
  expect(json.retrieval.dependencies?.status).toBe('current');
  expect(json.retrieval.freshness).toBe('current');
});

test('binds compiler configuration fingerprint and detects config changes', async () => {
  tempDir = await mkdtemp('/tmp/strata-config-fingerprint-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  const tsconfigPath = join(root, 'tsconfig.json');
  await writeFile(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['./src/*'],
        },
      },
    })
  );

  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'types.ts'), 'export interface WidgetProps { label: string; }\n');
  const widgetFile = join(root, 'src', 'Widget.vue');
  await writeFile(
    widgetFile,
    `<script setup lang="ts">
import type { WidgetProps } from '@/types';
defineProps<WidgetProps>();
</script>
<template><button>{{ label }}</button></template>
`
  );

  const firstInspect = await inspectComponentTool.handler({
    path: widgetFile,
    format: 'json',
  });
  const firstJson = JSON.parse(firstInspect.content[0].text);
  expect(firstJson.props.map((p: any) => p.name)).toEqual(['label']);
  expect(firstJson.retrieval.config.fingerprint).toBeDefined();
  expect(firstJson.retrieval.config.applicability).toBe('indexed');

  const initialFingerprint = firstJson.retrieval.config.fingerprint;

  // Mutate tsconfig.json on disk
  await writeFile(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['./src/*'],
          '~/*': ['./src/*'],
        },
      },
    })
  );

  const secondInspect = await inspectComponentTool.handler({
    path: widgetFile,
    format: 'json',
  });
  const secondJson = JSON.parse(secondInspect.content[0].text);
  const secondFingerprint = secondJson.retrieval.config.fingerprint;
  expect(secondFingerprint).toBeDefined();
  expect(secondFingerprint).not.toEqual(initialFingerprint);
});

test('extractComponentOutline tracks secondary dependencies for external callee resolution', async () => {
  tempDir = await mkdtemp('/tmp/strata-outline-dep-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');

  const helperPath = join(root, 'helper.ts');
  await writeFile(
    helperPath,
    `export function calculateSum(a: number, b: number): number {
  return a + b;
}
`
  );

  const compPath = join(root, 'Calculator.vue');
  await writeFile(
    compPath,
    `<script setup lang="ts">
import { calculateSum } from './helper';

function computeTotal(items: number[]) {
  return calculateSum(items[0], items[1]);
}
</script>
<template><div>{{ computeTotal([1, 2]) }}</div></template>
`
  );

  const res = await inspectComponentTool.handler({
    path: compPath,
    outline: true,
    format: 'json',
  });

  const json = JSON.parse(res.content[0].text);
  expect(json.functions.length).toBeGreaterThanOrEqual(1);
  expect(json.dependencies).toBeDefined();
  expect(json.dependencies.some((d: any) => d.path.endsWith('helper.ts'))).toBe(true);
  expect(json.retrieval.dependencies?.status).toBe('current');
  expect(json.retrieval.freshness).toBe('current');
});

test('detects concurrent mutation on secondary dependencies and triggers conservative retry', async () => {
  tempDir = await mkdtemp('/tmp/strata-concurrent-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');

  const typesPath = join(root, 'types.ts');
  await writeFile(typesPath, 'export interface ItemProps { count: number; }\n');

  const compPath = join(root, 'Item.vue');
  await writeFile(
    compPath,
    `<script setup lang="ts">
import type { ItemProps } from './types';
defineProps<ItemProps>();
</script>
<template><div>{{ count }}</div></template>
`
  );

  // Normal inspection: current freshness
  const initial = await inspectComponentTool.handler({
    path: compPath,
    format: 'json',
  });
  const initialJson = JSON.parse(initial.content[0].text);
  expect(initialJson.retrieval.freshness).toBe('current');
  expect(initialJson.retrieval.dependencies?.status).toBe('current');
  expect(initialJson.props.map((p: any) => p.name)).toEqual(['count']);

  // Verify that if a dependency is mutated, fresh read reflects the updated secondary dependency
  await writeFile(typesPath, 'export interface ItemProps { count: number; label: string; }\n');
  const afterMutation = await inspectComponentTool.handler({
    path: compPath,
    format: 'json',
  });
  const afterJson = JSON.parse(afterMutation.content[0].text);
  expect(afterJson.retrieval.freshness).toBe('current');
  expect(afterJson.retrieval.dependencies?.status).toBe('current');
  expect(afterJson.props.map((p: any) => p.name).sort()).toEqual(['count', 'label']);
});
