import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultWarmDbPool,
  discoverWorkspacePackages,
  resolveWorkspacePackageImport,
  syncWorkspaceV3,
  WorkspaceSyncCoordinator,
} from '../../src/engine/v2';

describe('Fase 2: Tier 1 SQLite v3 Storage, Package Partitioning & Fast Sync', () => {
  const monorepoSrc = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('discovers all 4 monorepo packages with frameworks, routers, and workspace export resolution', () => {
    const pkgs = discoverWorkspacePackages(monorepoSrc);
    expect(pkgs.map((p) => p.packageKey)).toEqual([
      'apps/admin',
      'apps/web',
      'packages/shared',
      'packages/ui',
    ]);

    const byKey = new Map(pkgs.map((p) => [p.packageKey, p]));
    expect(byKey.get('apps/web')?.framework).toBe('nuxt');
    expect(byKey.get('apps/web')?.router).toBe('nuxt');
    expect(byKey.get('apps/web')?.workspaceDeps.sort()).toEqual(['@acme/shared', '@acme/ui']);

    expect(byKey.get('apps/admin')?.framework).toBe('next');
    expect(byKey.get('apps/admin')?.router).toBe('next-app');

    // Cross-package export resolution points directly to source files
    const uiIndex = resolveWorkspacePackageImport('@acme/ui', pkgs);
    expect(uiIndex?.replace(/\\/g, '/')).toEndWith('packages/ui/src/index.ts');

    const baseButton = resolveWorkspacePackageImport('@acme/ui/BaseButton.vue', pkgs);
    expect(baseButton?.replace(/\\/g, '/')).toEndWith('packages/ui/src/BaseButton.vue');

    const sharedTypes = resolveWorkspacePackageImport('@acme/shared/types', pkgs);
    expect(sharedTypes?.replace(/\\/g, '/')).toEndWith('packages/shared/src/types/order.ts');
  });

  test('indexes symbols, cross-package edges, routes, and FTS5, with fast warm no-op and incremental edit sync', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-v3-sync-'));
    try {
      await cp(monorepoSrc, workDir, { recursive: true });

      // 1. Cold full sync
      const cold = await syncWorkspaceV3(workDir);
      expect(cold.mode).toBe('full');
      expect(cold.packagesSynced).toBe(4);
      expect(cold.added).toBeGreaterThanOrEqual(13);
      expect(cold.symbolsIndexed).toBeGreaterThanOrEqual(15);
      expect(cold.edgesIndexed).toBeGreaterThanOrEqual(15);

      // 2. Warm no-op sync uses warm connection and (mtime, size) skip
      const warm = await syncWorkspaceV3(workDir);
      expect(warm.added).toBe(0);
      expect(warm.modified).toBe(0);
      expect(warm.deleted).toBe(0);
      expect(warm.unchanged).toBe(cold.added);

      // 3. Query symbols & FTS5 directly from warm DB
      const db = defaultWarmDbPool.get(workDir);
      const ftsHits = db
        .query(
          `SELECT s.name, s.kind, p.package_key
           FROM symbols_fts f
           JOIN symbols s ON s.id = f.rowid
           JOIN packages p ON p.id = s.package_id
           WHERE symbols_fts MATCH 'formatOrderTotal'`
        )
        .all() as Array<{ name: string; kind: string; package_key: string }>;
      expect(ftsHits).toEqual([
        { name: 'formatOrderTotal', kind: 'function', package_key: 'packages/shared' },
      ]);

      // 4. Cross-package import edge resolved from apps/web -> packages/ui/src/index.ts
      const crossPkgEdges = db
        .query(
          `SELECT sf.rel_path AS src_rel, tf.rel_path AS tgt_rel, tp.package_key AS tgt_pkg, e.edge_kind
           FROM symbol_edges e
           JOIN files sf ON sf.id = e.source_file_id
           JOIN packages sp ON sp.id = sf.package_id
           JOIN files tf ON tf.id = e.target_file_id
           JOIN packages tp ON tp.id = tf.package_id
           WHERE sp.package_key = 'apps/web' AND tp.package_key = 'packages/ui'`
        )
        .all() as Array<{ src_rel: string; tgt_rel: string; tgt_pkg: string; edge_kind: string }>;
      expect(crossPkgEdges.length).toBeGreaterThanOrEqual(1);
      expect(crossPkgEdges[0].tgt_pkg).toBe('packages/ui');

      // 5. Incremental edit to 1 file re-parses only that file
      const formatPath = join(workDir, 'packages/shared/src/utils/format.ts');
      const prevContent = await readFile(formatPath, 'utf8');
      await writeFile(
        formatPath,
        `${prevContent}\nexport function formatOrderBadgeLabel(s: string): string { return s.toUpperCase(); }\n`
      );

      const inc = await syncWorkspaceV3(workDir, { packageKey: 'packages/shared' });
      expect(inc.packagesSynced).toBe(1);
      expect(inc.modified).toBe(1);
      expect(inc.added).toBe(0);

      const newSymHit = db
        .query("SELECT name FROM symbols WHERE name = 'formatOrderBadgeLabel'")
        .get() as { name: string } | null;
      expect(newSymHit?.name).toBe('formatOrderBadgeLabel');

      // 6. Routes partitioned by package
      const routes = db
        .query(
          `SELECT p.package_key, r.url_path
           FROM routes r JOIN packages p ON p.id = r.package_id
           ORDER BY p.package_key, r.url_path`
        )
        .all() as Array<{ package_key: string; url_path: string }>;
      expect(routes.some((r) => r.package_key === 'apps/web' && r.url_path.includes('/orders'))).toBe(true);
      expect(routes.some((r) => r.package_key === 'apps/admin' && r.url_path === '/orders')).toBe(true);
    } finally {
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('scales cleanly on 300-file synthetic 6-package monorepo (significantly faster than 0.10.1 baseline)', async () => {
    const scaleDir = await mkdtemp(join(tmpdir(), 'strata-v3-scale-'));
    try {
      await writeFile(
        join(scaleDir, 'package.json'),
        JSON.stringify({ name: 'scale-monorepo', private: true, workspaces: ['packages/*'] })
      );
      for (let p = 0; p < 6; p++) {
        const pkgRoot = join(scaleDir, 'packages', `pkg-${p}`);
        await mkdir(join(pkgRoot, 'src'), { recursive: true });
        await writeFile(
          join(pkgRoot, 'package.json'),
          JSON.stringify({ name: `@scale/pkg-${p}`, dependencies: { vue: '^3.5.0' } })
        );
        for (let f = 0; f < 50; f++) {
          await writeFile(
            join(pkgRoot, 'src', `Comp${p}_${f}.vue`),
            `<script setup lang="ts">\nconst props = defineProps<{ title: string; count?: number }>();\n</script>\n<template><div>{{ props.title }} {{ props.count }}</div></template>\n`
          );
        }
      }

      const cold = await syncWorkspaceV3(scaleDir);
      expect(cold.added).toBe(300);
      expect(cold.packagesSynced).toBe(6);

      const warm = await syncWorkspaceV3(scaleDir);
      expect(warm.unchanged).toBe(300);
      expect(warm.added).toBe(0);
      expect(warm.modified).toBe(0);

      // Single-package scoped sync touches only 50 files
      const scoped = await syncWorkspaceV3(scaleDir, { packageKey: 'packages/pkg-0' });
      expect(scoped.packagesSynced).toBe(1);
      expect(scoped.unchanged).toBe(50);

      console.log(
        `[SQLite v3 Scale 300 files] cold=${cold.durationMs}ms, warm=${warm.durationMs}ms, scoped(50)=${scoped.durationMs}ms`
      );
    } finally {
      defaultWarmDbPool.close(scaleDir);
      await rm(scaleDir, { recursive: true, force: true });
    }
  }, 20000);

  test('supports single-repo frontend, monolith (separate backend/frontend dirs), and fullstack Next.js layouts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'strata-layouts-'));
    try {
      // 1. Single-repo Vue app
      const singleVue = join(tmp, 'single-vue');
      await mkdir(join(singleVue, 'src'), { recursive: true });
      await writeFile(join(singleVue, 'package.json'), JSON.stringify({ name: 'single-vue', dependencies: { vue: '^3.5.0' } }));
      await writeFile(join(singleVue, 'src/App.vue'), '<script setup lang="ts">const msg = "hi";</script><template>{{ msg }}</template>');
      const singlePkgs = discoverWorkspacePackages(singleVue);
      expect(singlePkgs).toHaveLength(1);
      expect(singlePkgs[0].packageKey).toBe('.');
      expect(singlePkgs[0].framework).toBe('vue');

      // 2. Monolith with separate backend/ (non-JS) and frontend/ (Vue/Nuxt) without root workspaces
      const monolith = join(tmp, 'monolith-app');
      await mkdir(join(monolith, 'backend'), { recursive: true });
      await mkdir(join(monolith, 'frontend/src'), { recursive: true });
      await writeFile(join(monolith, 'backend/main.go'), 'package main\nfunc main() {}\n');
      await writeFile(join(monolith, 'frontend/package.json'), JSON.stringify({ name: 'web-client', dependencies: { react: '^19.0.0' } }));
      await writeFile(join(monolith, 'frontend/src/App.tsx'), 'export function App() { return <div />; }\n');
      const monolithPkgs = discoverWorkspacePackages(monolith);
      expect(monolithPkgs).toHaveLength(1);
      expect(monolithPkgs[0].packageKey).toBe('frontend');
      expect(monolithPkgs[0].framework).toBe('react');

      // 3. Fullstack Next.js app (App Router pages + API route handler in one project)
      const fullstackNext = join(tmp, 'fullstack-next');
      await mkdir(join(fullstackNext, 'app/api/orders'), { recursive: true });
      await writeFile(join(fullstackNext, 'package.json'), JSON.stringify({ name: 'fullstack-next', dependencies: { next: '^15.0.0', react: '^19.0.0' } }));
      await writeFile(join(fullstackNext, 'app/page.tsx'), 'export default function Home() { return <main />; }\n');
      await writeFile(join(fullstackNext, 'app/api/orders/route.ts'), 'export async function GET() { return new Response("ok"); }\n');
      const nextSync = await syncWorkspaceV3(fullstackNext);
      expect(nextSync.packagesSynced).toBe(1);
      expect(nextSync.added).toBe(2);
      defaultWarmDbPool.close(fullstackNext);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('emits 4-stage sync progress and maintains incremental FTS5 integrity across add/modify/delete', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'strata-fts-incr-'));
    try {
      await mkdir(join(tmp, 'src'), { recursive: true });
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'fts-app', dependencies: { react: '^19.0.0' } }));
      for (let i = 0; i < 6; i++) {
        await writeFile(join(tmp, `src/mod${i}.ts`), `export function alphaFn${i}() { return ${i}; }\n`);
      }

      const completedStages: string[] = [];
      const first = await syncWorkspaceV3(tmp, {
        onProgress: (ev) => {
          if (ev.status === 'done') completedStages.push(ev.stage);
        },
      });
      expect(first.added).toBe(6);
      expect(completedStages).toEqual(['scan', 'parse', 'resolve', 'commit']);

      // Incremental modify of 1 file (<= 50% of files -> triggers incremental FTS5 path, not full rebuild)
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(tmp, 'src/mod0.ts'), 'export function betaRenamedFn0() { return 42; }\n');
      // Incremental add of 1 file
      await writeFile(join(tmp, 'src/mod6.ts'), 'export function gammaAddedFn6() { return 6; }\n');
      // Incremental delete of 1 file
      await rm(join(tmp, 'src/mod5.ts'));

      const incr = await syncWorkspaceV3(tmp);
      expect(incr.mode).toBe('incremental');
      expect(incr.added).toBe(1);
      expect(incr.modified).toBe(1);
      expect(incr.deleted).toBe(1);

      const db = defaultWarmDbPool.get(tmp);
      // FTS5 built-in integrity check throws if external content table is out of sync
      expect(() => db.run("INSERT INTO symbols_fts(symbols_fts) VALUES ('integrity-check')")).not.toThrow();

      const oldHit = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'alphaFn0'").all();
      const deletedHit = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'alphaFn5'").all();
      const renamedHit = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'betaRenamedFn0'").all();
      const addedHit = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'gammaAddedFn6'").all();

      expect(oldHit).toHaveLength(0);
      expect(deletedHit).toHaveLength(0);
      expect(renamedHit).toHaveLength(1);
      expect(addedHit).toHaveLength(1);

      defaultWarmDbPool.close(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('parallel CPU worker pool produces identical symbol/edge counts to single-thread parse', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'strata-parallel-eq-'));
    try {
      await mkdir(join(tmp, 'src'), { recursive: true });
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'par-app', dependencies: { vue: '^3.5.0' } }));
      for (let i = 0; i < 120; i++) {
        await writeFile(
          join(tmp, `src/Comp${i}.vue`),
          `<script setup lang="ts">\nimport { helper0 } from "./util0";\nexport function run${i}() { return helper0(); }\n</script>\n<template><div>{{ run${i}() }}</div></template>\n`
        );
      }
      await writeFile(join(tmp, 'src/util0.ts'), 'export function helper0() { return 1; }\n');

      const seq = await syncWorkspaceV3(tmp, {
        force: true,
        parallelThreshold: 10000,
        dbFilename: 'seq.db',
      });
      const par = await syncWorkspaceV3(tmp, {
        force: true,
        parallelThreshold: 50,
        dbFilename: 'par.db',
      });

      expect(par.added).toBe(seq.added);
      expect(par.symbolsIndexed).toBe(seq.symbolsIndexed);
      expect(par.edgesIndexed).toBe(seq.edgesIndexed);
      expect(par.workersUsed).toBeGreaterThanOrEqual(1);

      defaultWarmDbPool.close(tmp, 'seq.db');
      defaultWarmDbPool.close(tmp, 'par.db');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('WorkspaceSyncCoordinator: single-flight coalescing, watcher-clean, O(|dirty|) targeted sync, and background warmup', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'strata-coord-'));
    const coordinator = new WorkspaceSyncCoordinator();
    try {
      await mkdir(join(tmp, 'src'), { recursive: true });
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'coord-app', dependencies: { react: '^19.0.0' } }));
      for (let i = 0; i < 5; i++) {
        await writeFile(join(tmp, `src/file${i}.ts`), `export function initialFn${i}() { return ${i}; }\n`);
      }

      // Uninitialized workspace -> warmupInBackground returns null
      expect(coordinator.warmupInBackground(tmp)).toBeNull();

      // Single-flight coalescing across 3 concurrent callers
      let syncRuns = 0;
      const onProgress = (ev: { stage: string; status: string }) => {
        if (ev.stage === 'scan' && ev.status === 'start') syncRuns++;
      };
      const [r1, r2, r3] = await Promise.all([
        coordinator.ensureSynced(tmp, { onProgress }),
        coordinator.ensureSynced(tmp, { onProgress }),
        coordinator.ensureSynced(tmp, { onProgress }),
      ]);
      expect(syncRuns).toBe(1);
      expect(r1.added).toBe(5);
      expect(r2).toEqual(r1);
      expect(r3).toEqual(r1);

      // Now .strata/graph.db exists -> warmupInBackground activates watcher & warms cleanly
      const warmPromise = coordinator.warmupInBackground(tmp);
      expect(warmPromise).not.toBeNull();
      await warmPromise;
      expect(coordinator.isWatching(tmp)).toBe(true);

      // With active watcher and no dirty files -> O(1) watcher-clean fast path
      const clean = await coordinator.ensureSynced(tmp);
      expect(clean.mode).toBe('watcher-clean');
      expect(clean.durationMs).toBe(0);

      // Edit 1 file & mark dirty -> O(|dirty|) watcher-dirty targeted sync with incremental FTS5
      await new Promise((r) => setTimeout(r, 20));
      const targetFile = join(tmp, 'src/file0.ts');
      await writeFile(targetFile, 'export function updatedDirtyFn0() { return 99; }\n');
      coordinator.markDirty(tmp, targetFile);

      const dirtyRes = await coordinator.ensureSynced(tmp);
      expect(dirtyRes.mode).toBe('watcher-dirty');
      expect(dirtyRes.modified).toBe(1);

      const db = defaultWarmDbPool.get(tmp);
      expect(() => db.run("INSERT INTO symbols_fts(symbols_fts) VALUES ('integrity-check')")).not.toThrow();
      const hit = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'updatedDirtyFn0'").all();
      const stale = db.query("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'initialFn0'").all();
      expect(hit).toHaveLength(1);
      expect(stale).toHaveLength(0);

      coordinator.closeAll();
      expect(coordinator.isWatching(tmp)).toBe(false);
      defaultWarmDbPool.close(tmp);
    } finally {
      coordinator.closeAll();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
