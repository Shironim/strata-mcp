import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultWarmDbPool,
  inspectFile,
  mapWorkspace,
  queryGraph,
  readSlice,
  searchCode,
  SemanticProjectPool,
  StaleSourceError,
  ValidationError,
  WorkspaceBoundaryError,
} from '../../src/engine/v2';

describe('Fase 4: Unified Query & Inspection Services (8/8 Baseline Probes + Error Boundaries)', () => {
  const monorepoSrc = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('passes all 8 monorepo baseline probes end-to-end across all 5 services', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-v2-services-'));
    const semanticPool = new SemanticProjectPool({ maxActiveProjects: 3 });

    try {
      await cp(monorepoSrc, workDir, { recursive: true });
      const opts = { semanticPool };

      // 1. mapWorkspace: overview & routes (Probe 8)
      const overview = await mapWorkspace({ workspaceRoot: workDir, view: 'overview', ...opts });
      expect(overview.verification).toBe('graph');
      expect(overview.data.totals?.packages).toBe(4);

      const routes = await mapWorkspace({ workspaceRoot: workDir, view: 'routes', skipSync: true, ...opts });
      const routePairs = (routes.data.routes ?? []).map((r) => `${r.packageKey}:${r.urlPath}`);
      expect(routePairs.some((p) => p.startsWith('apps/web:/orders'))).toBe(true);
      expect(routePairs.some((p) => p === 'apps/admin:/orders')).toBe(true);

      // 2. inspectFile: Vue external Omit<OrderDTO, 'internalNote'> & { compact?: boolean } (Probe 1)
      const vueCardInspect = await inspectFile({
        workspaceRoot: workDir,
        path: 'packages/ui/src/OrderSummaryCard.vue',
        skipSync: true,
        ...opts,
      });
      expect(vueCardInspect.verification).toBe('semantic');
      expect(vueCardInspect.data.contract?.props.map((p) => p.name).sort()).toEqual([
        'compact',
        'customerName',
        'id',
        'status',
        'totalCents',
      ]);

      // 3. inspectFile: React extends PublicOrderSummary (Probe 2)
      const reactCardInspect = await inspectFile({
        workspaceRoot: workDir,
        path: 'packages/ui/src/ActionCard.tsx',
        skipSync: true,
        ...opts,
      });
      expect(reactCardInspect.verification).toBe('semantic');
      expect(reactCardInspect.data.contract?.props.map((p) => p.name).sort()).toEqual([
        'customerName',
        'highlight',
        'id',
        'onApprove',
        'status',
        'totalCents',
      ]);

      // 4. inspectFile: Nuxt page traces outbound POST /api/orders/:id/cancel via auto-imported useOrderApi (Probe 6)
      const webPageInspect = await inspectFile({
        workspaceRoot: workDir,
        path: 'apps/web/pages/orders/[id].vue',
        skipSync: true,
        ...opts,
      });
      const outbound = webPageInspect.data.boundaries?.outboundHttp ?? [];
      expect(
        outbound.some(
          (b) =>
            b.method === 'POST' &&
            b.url === '/api/orders/:id/cancel' &&
            b.source === 'composable'
        )
      ).toBe(true);

      // 5. queryGraph(componentTree): Cross-package upward consumers for Vue & React (Probes 3 & 4)
      const collectPaths = (node: any, acc = new Set<string>()): Set<string> => {
        if (node?.filePath) acc.add(node.filePath.replace(/\\/g, '/'));
        for (const c of node?.children ?? []) collectPaths(c, acc);
        return acc;
      };

      const vueUpward = await queryGraph({
        workspaceRoot: workDir,
        query: 'componentTree',
        target: { file: 'packages/ui/src/BaseButton.vue' },
        direction: 'up',
        skipSync: true,
        ...opts,
      });
      const vuePaths = [...collectPaths(vueUpward.data.tree)];
      expect(vuePaths.some((p) => p.endsWith('packages/ui/src/OrderSummaryCard.vue'))).toBe(true);
      expect(vuePaths.some((p) => p.endsWith('apps/web/pages/orders/[id].vue'))).toBe(true);

      const reactUpward = await queryGraph({
        workspaceRoot: workDir,
        query: 'componentTree',
        target: { file: 'packages/ui/src/ActionCard.tsx' },
        direction: 'up',
        skipSync: true,
        ...opts,
      });
      const reactPaths = [...collectPaths(reactUpward.data.tree)];
      expect(reactPaths.some((p) => p.endsWith('apps/admin/app/orders/OrderPanel.tsx'))).toBe(true);
      expect(reactPaths.some((p) => p.endsWith('apps/admin/app/orders/page.tsx'))).toBe(true);

      // 6. queryGraph(stateFlow): Detects useOrderStore usage in Nuxt page (Probe 5)
      const stateFlow = await queryGraph({
        workspaceRoot: workDir,
        query: 'stateFlow',
        target: { symbol: 'useOrderStore' },
        skipSync: true,
        ...opts,
      });
      expect(
        (stateFlow.data.items ?? []).some((i) => i.filePath.replace(/\\/g, '/').endsWith('apps/web/pages/orders/[id].vue'))
      ).toBe(true);

      // 7. queryGraph(impact): Surfaces v-bind="extraButtonAttrs" omission on BaseButton (Probe 7)
      const impact = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'packages/ui/src/BaseButton.vue', member: 'variant' },
        skipSync: true,
        ...opts,
      });
      expect(
        (impact.data.items ?? []).some((i) =>
          i.filePath.replace(/\\/g, '/').endsWith('packages/ui/src/OrderSummaryCard.vue')
        )
      ).toBe(true);
      expect(
        impact.omissions.some(
          (o) =>
            o.code === 'DYNAMIC_SPREAD' &&
            o.filePath.replace(/\\/g, '/').endsWith('apps/web/pages/orders/[id].vue')
        )
      ).toBe(true);

      // 8. queryGraph(references): Cross-package semantic references with summaryByPackage
      const refs = await queryGraph({
        workspaceRoot: workDir,
        query: 'references',
        target: { file: 'packages/shared/src/utils/format.ts', symbol: 'formatOrderTotal' },
        skipSync: true,
        ...opts,
      });
      expect(refs.verification).toBe('semantic');
      expect((refs.data.summaryByPackage ?? []).map((g) => g.packageKey)).toContain('packages/ui');

      // 9. searchCode: FTS5 symbol search + componentUsage + propUsage
      const symSearch = await searchCode({
        workspaceRoot: workDir,
        query: 'formatOrderTotal',
        kind: 'symbol',
        skipSync: true,
        ...opts,
      });
      expect(symSearch.data.matches).toHaveLength(1);
      expect(symSearch.data.matches[0].symbolId).toBeDefined();

      const compUsage = await searchCode({
        workspaceRoot: workDir,
        query: 'BaseButton',
        kind: 'componentUsage',
        skipSync: true,
        ...opts,
      });
      expect(compUsage.data.matches.length).toBeGreaterThanOrEqual(2);

      // 10. readSlice: Round-trip composable sourceRef handle from inspectFile
      const onCancelSym = (webPageInspect.data.outline ?? []).find((s) => s.name === 'onCancel');
      expect(onCancelSym).toBeDefined();
      const slice = await readSlice({
        workspaceRoot: workDir,
        sourceRef: onCancelSym!.sourceRef,
        skipSync: true,
        ...opts,
      });
      expect(slice.data.content).toContain('async function onCancel');

      // 11. Unhappy path: StaleSourceError when file changes on disk after sourceRef was issued
      const webPagePath = join(workDir, 'apps/web/pages/orders/[id].vue');
      const prevRaw = await readFile(webPagePath, 'utf8');
      await writeFile(webPagePath, `${prevRaw}\n<!-- edited -->\n`);
      await expect(
        readSlice({
          workspaceRoot: workDir,
          sourceRef: onCancelSym!.sourceRef,
          skipSync: true,
          ...opts,
        })
      ).rejects.toThrow(StaleSourceError);

      // 12. Security & validation error boundaries
      await expect(
        readSlice({ workspaceRoot: workDir, path: '../../../etc/passwd', skipSync: true, ...opts })
      ).rejects.toThrow(WorkspaceBoundaryError);

      await expect(
        mapWorkspace({ workspaceRoot: workDir, view: 'invalid_view' as any, skipSync: true, ...opts })
      ).rejects.toThrow(ValidationError);
    } finally {
      semanticPool.disposeAll();
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);
});
