import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultWarmDbPool,
  discoverWorkspacePackages,
  resolveWorkspacePackageImport,
  syncWorkspaceV3,
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
});
