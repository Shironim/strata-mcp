import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSemanticPool,
  defaultWarmDbPool,
  inspectFile,
  queryGraph,
  searchCode,
  syncWorkspaceV3,
} from '../../src/engine/v2';
import { linkWorkspaceEdges } from '../../src/engine/v2/graph-linker';
import { resolveWorkspacePackageImport, type WorkspacePackageInfo } from '../../src/engine/v2/workspace-packages';
import { AnalysisSupervisor, isFastReadOnlyJob } from '../../src/analysis-supervisor';

const tempDirs: string[] = [];

function createTempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

afterEach(() => {
  defaultSemanticPool.disposeAll();
  defaultWarmDbPool.closeAll();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Scalability & Complexity Optimizations (Phases A-E)', () => {
  test('1. query_graph(impact) with limit: 1 returns full summaryByPackage and accurate paginated page via single batch SQL', async () => {
    const workDir = createTempWorkspace('strata-scale-impact-');
    writeFile(
      workDir,
      'package.json',
      JSON.stringify({ name: 'impact-monorepo', private: true, workspaces: ['packages/*', 'apps/*'] })
    );
    writeFile(
      workDir,
      'packages/ui/package.json',
      JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './*': './src/*' } })
    );
    writeFile(
      workDir,
      'packages/ui/src/VButton.vue',
      `<template><button><slot /></button></template>
<script setup lang="ts">
defineProps<{ label?: string }>();
</script>`
    );
    writeFile(
      workDir,
      'packages/ui/src/index.ts',
      `export { default as VButton } from './VButton.vue';\n`
    );
    writeFile(
      workDir,
      'apps/web/package.json',
      JSON.stringify({ name: 'web-app', dependencies: { vue: '^3.5.0', '@acme/ui': '*' } })
    );
    writeFile(
      workDir,
      'apps/web/src/PageA.vue',
      `<template><VButton label="A" /></template>
<script setup lang="ts">
import { VButton } from '@acme/ui';
</script>`
    );
    writeFile(
      workDir,
      'apps/web/src/PageB.vue',
      `<template><VButton label="B" /></template>
<script setup lang="ts">
import { VButton } from '@acme/ui';
</script>`
    );
    writeFile(
      workDir,
      'apps/admin/package.json',
      JSON.stringify({ name: 'admin-app', dependencies: { vue: '^3.5.0', '@acme/ui': '*' } })
    );
    writeFile(
      workDir,
      'apps/admin/src/AdminPage.vue',
      `<template><VButton label="Admin" /></template>
<script setup lang="ts">
import { VButton } from '@acme/ui';
</script>`
    );

    await syncWorkspaceV3(workDir);

    const fullRes = await queryGraph({
      workspaceRoot: workDir,
      query: 'impact',
      target: { file: 'packages/ui/src/VButton.vue' },
      limit: 50,
      skipSync: true,
    });

    const page1 = await queryGraph({
      workspaceRoot: workDir,
      query: 'impact',
      target: { file: 'packages/ui/src/VButton.vue' },
      limit: 1,
      skipSync: true,
    });

    expect(fullRes.data.items).toHaveLength(3);
    expect(page1.data.items).toHaveLength(1);
    expect(page1.pagination?.hasMore).toBe(true);
    expect(page1.pagination?.total).toBe(3);
    expect(page1.data.summaryByPackage).toEqual([
      { packageKey: 'apps/web', count: 2, fileCount: 2 },
      { packageKey: 'apps/admin', count: 1, fileCount: 1 },
    ]);
    expect(page1.data.items![0].sourceRef).toBe(fullRes.data.items![0].sourceRef);

    // Follow cursor to page 2
    const page2 = await queryGraph({
      workspaceRoot: workDir,
      query: 'impact',
      target: { file: 'packages/ui/src/VButton.vue' },
      limit: 1,
      cursor: page1.pagination?.nextCursor,
      skipSync: true,
    });
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items![0].sourceRef).toBe(fullRes.data.items![1].sourceRef);
  });

  test('2. search_code(propUsage) with SQL LIKE pre-filter finds props and events accurately without false negatives', async () => {
    const root = createTempWorkspace('strata-scale-propusage-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'prop-usage-app', dependencies: { vue: '^3.5.0' } }));
    writeFile(
      root,
      'src/components/VButton.vue',
      `<template><button><slot /></button></template>
<script setup lang="ts">
defineProps<{ variant?: 'primary' | 'ghost'; size?: 'sm' | 'md' }>();
defineEmits<{ (e: 'submitOrder'): void }>();
</script>`
    );
    writeFile(
      root,
      'src/App.vue',
      `<template>
  <VButton variant="primary" @submitOrder="onSave">Save</VButton>
  <VButton size="sm">Cancel</VButton>
</template>
<script setup lang="ts">
import VButton from './components/VButton.vue';
const onSave = () => {};
</script>`
    );

    await syncWorkspaceV3(root);

    const propMatches = await searchCode({
      workspaceRoot: root,
      kind: 'propUsage',
      query: 'variant',
      skipSync: true,
    });
    expect(propMatches.data.matches).toHaveLength(1);
    expect(propMatches.data.matches[0].name).toBe('VButton#variant');

    const eventMatches = await searchCode({
      workspaceRoot: root,
      kind: 'propUsage',
      query: 'submitOrder',
      skipSync: true,
    });
    expect(eventMatches.data.matches).toHaveLength(1);
    expect(eventMatches.data.matches[0].name).toBe('VButton#submitOrder');

    // Substring that appears in JSON keys ("props") must NOT cause false positives
    const keyMatches = await searchCode({
      workspaceRoot: root,
      kind: 'propUsage',
      query: 'props',
      skipSync: true,
    });
    expect(keyMatches.data.matches).toHaveLength(0);
  });

  test('3. inspect_file(boundaries) resolves 1-hop composable outbound HTTP directly via SQLite graph even with resolveTypes=false', async () => {
    const root = createTempWorkspace('strata-scale-boundaries-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'nuxt-graph-http', dependencies: { nuxt: '^3.14.0' } }));
    writeFile(
      root,
      'composables/useOrdersApi.ts',
      `export function useOrdersApi() {
  return $fetch('/api/orders', { method: 'POST' });
}`
    );
    writeFile(
      root,
      'pages/orders.vue',
      `<template><div>Orders</div></template>
<script setup lang="ts">
const data = await useOrdersApi();
</script>`
    );

    await syncWorkspaceV3(root);

    // resolveTypes: false ensures SemanticProjectPool is NOT invoked; 1-hop must come from SQLite graph
    const inspection = await inspectFile({
      workspaceRoot: root,
      path: 'pages/orders.vue',
      sections: ['boundaries'],
      resolveTypes: false,
      skipSync: true,
    });

    const http = inspection.data.boundaries?.outboundHttp ?? [];
    expect(http.some((h) => h.method === 'POST' && h.url === '/api/orders' && h.source === 'composable' && h.viaSymbol === 'useOrdersApi')).toBe(true);
  });

  test('4. AnalysisSupervisor executes fast read-only jobs concurrently without head-of-line blocking', async () => {
    expect(isFastReadOnlyJob('map_workspace', { view: 'overview' })).toBe(true);
    expect(isFastReadOnlyJob('read_slice', { path: 'a.ts' })).toBe(true);
    expect(isFastReadOnlyJob('search_code', { kind: 'symbol', query: 'Foo' })).toBe(true);
    expect(isFastReadOnlyJob('inspect_file', { path: 'a.ts', resolve_types: false })).toBe(true);
    expect(isFastReadOnlyJob('inspect_file', { path: 'a.ts' })).toBe(false);
    expect(isFastReadOnlyJob('query_graph', { query: 'component_tree' })).toBe(true);
    expect(isFastReadOnlyJob('query_graph', { query: 'definition' })).toBe(false);

    const supervisor = new AnalysisSupervisor();
    try {
      const root = createTempWorkspace('strata-scale-supervisor-');
      writeFile(root, 'package.json', JSON.stringify({ name: 'sup-app' }));
      writeFile(root, 'src/a.ts', 'export const a = 1;\n');
      await syncWorkspaceV3(root);

      const started = performance.now();
      const results = await Promise.all([
        supervisor.run('map_workspace', { root, view: 'overview' }, root),
        supervisor.run('search_code', { root, kind: 'symbol', query: 'a' }, root),
        supervisor.run('read_slice', { root, path: 'src/a.ts', lines: { start: 1, end: 1 } }, root),
        supervisor.run('query_graph', { root, query: 'state_flow', target: { symbol: 'missingStore' } }, root),
      ]);
      const elapsed = performance.now() - started;

      expect(results).toHaveLength(4);
      for (const r of results) {
        expect(r.isError).not.toBe(true);
      }
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await supervisor.close();
    }
  });

  test('5. resolveWorkspacePackageImport O(1) lookup and scoped linkWorkspaceEdges preserve exact behavior', async () => {
    const root = createTempWorkspace('strata-scale-pkg-lookup-');
    const pkgRoot = join(root, 'packages/ui');
    const buttonPath = writeFile(root, 'packages/ui/src/Button.vue', '<template><button /></template>');
    const indexPath = writeFile(root, 'packages/ui/src/index.ts', 'export { default as Button } from "./Button.vue";');

    const packages: WorkspacePackageInfo[] = [
      {
        packageKey: 'packages/ui',
        name: '@acme/ui',
        rootPath: pkgRoot,
        framework: 'vue',
        router: 'none',
        isRoot: false,
        exportsMap: { '.': './src/index.ts', './*': './src/*' },
        tsconfigPath: null,
        nuxtImportsDts: null,
      },
    ];
    const fileSet = new Set([buttonPath, indexPath]);

    expect(resolveWorkspacePackageImport('@acme/ui', packages, fileSet)).toBe(indexPath);
    expect(resolveWorkspacePackageImport('@acme/ui/Button.vue', packages, fileSet)).toBe(buttonPath);
    expect(resolveWorkspacePackageImport('@acme/unknown', packages, fileSet)).toBeNull();
    expect(resolveWorkspacePackageImport('./local', packages, fileSet)).toBeNull();

    // Scoped linkWorkspaceEdges with empty array returns 0 without scanning
    const db = defaultWarmDbPool.get(root);
    expect(linkWorkspaceEdges(db, { scopedSourceFileIds: [] })).toEqual({ linkedRenders: 0, linkedCalls: 0 });
  });
});
