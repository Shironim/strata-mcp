import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SemanticProjectPool } from '../../src/engine/v2/semantic';

describe('Fase 3: Tier 2 Scoped Semantic Engine (ts.LanguageService + Virtual TSX)', () => {
  const monorepoRoot = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('expands Vue defineProps<Omit<OrderDTO, "internalNote"> & { compact?: boolean }>() across monorepo packages', () => {
    const pool = new SemanticProjectPool({ maxActiveProjects: 3 });
    try {
      const vuePath = resolve(monorepoRoot, 'packages/ui/src/OrderSummaryCard.vue');
      const props = pool.expandComponentProps(monorepoRoot, vuePath);
      const names = props.map((p) => p.name).sort();

      // Directly fixes the 0.10.1 baseline failure (which returned [])
      expect(names).toEqual(['compact', 'customerName', 'id', 'status', 'totalCents']);
      expect(props.find((p) => p.name === 'compact')?.required).toBe(false);
      expect(props.find((p) => p.name === 'id')?.required).toBe(true);
      expect(props.find((p) => p.name === 'status')?.type).toContain('pending');
    } finally {
      pool.disposeAll();
    }
  });

  test('expands React interface ActionCardProps extends PublicOrderSummary across monorepo packages', () => {
    const pool = new SemanticProjectPool({ maxActiveProjects: 3 });
    try {
      const reactPath = resolve(monorepoRoot, 'packages/ui/src/ActionCard.tsx');
      const props = pool.expandComponentProps(monorepoRoot, reactPath);
      const names = props.map((p) => p.name).sort();

      expect(names).toEqual(['customerName', 'highlight', 'id', 'onApprove', 'status', 'totalCents']);
      expect(props.find((p) => p.name === 'highlight')?.required).toBe(false);
      expect(props.find((p) => p.name === 'onApprove')?.required).toBe(true);
    } finally {
      pool.disposeAll();
    }
  });

  test('resolves Go-to-Definition for Nuxt auto-imported useOrderApi() and cancelOrder() via .nuxt/imports.d.ts', () => {
    const pool = new SemanticProjectPool({ maxActiveProjects: 3 });
    try {
      const pagePath = resolve(monorepoRoot, 'apps/web/pages/orders/[id].vue');
      const raw = readFileSync(pagePath, 'utf8');

      const apiOffset = raw.indexOf('useOrderApi()');
      expect(apiOffset).toBeGreaterThan(0);

      const defs = pool.getDefinitionsAtOffset(monorepoRoot, pagePath, apiOffset + 2);
      expect(defs.length).toBeGreaterThanOrEqual(1);
      // Resolves via .nuxt/imports.d.ts to imports.d.ts or composables/useOrderApi.ts
      const defPaths = defs.map((d) => d.filePath.replace(/\\/g, '/'));
      expect(
        defPaths.some((p) => p.endsWith('.nuxt/imports.d.ts') || p.endsWith('composables/useOrderApi.ts'))
      ).toBe(true);

      // Go-to-Definition on cancelOrder inside onCancel() jumps straight to composables/useOrderApi.ts
      const cancelCallOffset = raw.indexOf('await cancelOrder(') + 'await '.length;
      const cancelDefs = pool.getDefinitionsAtOffset(monorepoRoot, pagePath, cancelCallOffset + 2);
      expect(cancelDefs.some((d) => d.filePath.replace(/\\/g, '/').endsWith('composables/useOrderApi.ts'))).toBe(true);
    } finally {
      pool.disposeAll();
    }
  });

  test('finds cross-package references across Vue <template> and React JSX with original file line numbers', () => {
    const pool = new SemanticProjectPool({ maxActiveProjects: 3 });
    try {
      const formatPath = resolve(monorepoRoot, 'packages/shared/src/utils/format.ts');
      const raw = readFileSync(formatPath, 'utf8');
      const fnOffset = raw.indexOf('formatOrderTotal');
      expect(fnOffset).toBeGreaterThan(0);

      const refs = pool.findReferencesAtOffset(
        monorepoRoot,
        formatPath,
        fnOffset + 2,
        ['packages/shared', 'packages/ui']
      );

      const refFiles = new Set(refs.map((r) => r.filePath.replace(/\\/g, '/')));
      expect([...refFiles].some((f) => f.endsWith('packages/ui/src/OrderSummaryCard.vue'))).toBe(true);
      expect([...refFiles].some((f) => f.endsWith('packages/ui/src/ActionCard.tsx'))).toBe(true);

      // Verify Vue template usage line is accurately remapped to the original .vue file
      const vueTemplateRef = refs.find(
        (r) =>
          r.filePath.replace(/\\/g, '/').endsWith('packages/ui/src/OrderSummaryCard.vue') &&
          r.kind === 'template-expr'
      );
      expect(vueTemplateRef).toBeDefined();
      const vueLines = readFileSync(
        resolve(monorepoRoot, 'packages/ui/src/OrderSummaryCard.vue'),
        'utf8'
      ).split('\n');
      expect(vueLines[vueTemplateRef!.line - 1]).toContain('formatOrderTotal(props.totalCents)');
    } finally {
      pool.disposeAll();
    }
  });

  test('enforces LRU maxActiveProjects bound across monorepo packages', () => {
    const pool = new SemanticProjectPool({ maxActiveProjects: 2 });
    try {
      pool.acquireProject(monorepoRoot, 'packages/shared');
      pool.acquireProject(monorepoRoot, 'packages/ui');
      expect(pool.getActiveProjectCount()).toBe(2);

      // Acquiring a 3rd package must evict the least recently used one
      pool.acquireProject(monorepoRoot, 'apps/web');
      expect(pool.getActiveProjectCount()).toBe(2);
    } finally {
      pool.disposeAll();
    }
  });

  test('handles pure-JS legacy package without tsconfig.json via synthetic compiler config', async () => {
    const jsDir = await mkdtemp(join(tmpdir(), 'strata-v3-purejs-'));
    const pool = new SemanticProjectPool({ maxActiveProjects: 2 });
    try {
      await writeFile(join(jsDir, 'package.json'), JSON.stringify({ name: 'legacy-js' }));
      await writeFile(
        join(jsDir, 'math.js'),
        'export function addTotal(a, b) { return a + b; }\n'
      );
      const appPath = join(jsDir, 'app.js');
      const appCode = "import { addTotal } from './math';\nexport const res = addTotal(1, 2);\n";
      await writeFile(appPath, appCode);

      const callOffset = appCode.indexOf('addTotal(1');
      const defs = pool.getDefinitionsAtOffset(jsDir, appPath, callOffset + 2);
      expect(defs.some((d) => d.filePath.replace(/\\/g, '/').endsWith('/math.js'))).toBe(true);
    } finally {
      pool.disposeAll();
      await rm(jsDir, { recursive: true, force: true });
    }
  });
});
