import { describe, it, expect } from 'bun:test';
import { synthesizeBackendTargetHint, formatApiContractsAsText } from '../../src/engine/api-contract';
import { formatRetrievalEvidence } from '../../src/engine/retrieval-evidence';
import { formatPatchPlanAsText } from '../../src/tools/patch-plan';
import { getUpwardComponentTree } from '../../src/engine/graph/upward-traversal';
import { getComponentTree } from '../../src/engine/tree';
import { extractPassedProps } from '../../src/engine/graph/props-drilling';
import { isPageFile } from '../../src/engine/graph/path-helpers';
import { mapSourceFile } from '../../src/engine/source-map';
import { findComponentUsage } from '../../src/engine/search';
import { extractDataDependencies } from '../../src/engine/parsers/state-dependency';
import { mapFrontendScope } from '../../src/engine/frontend-map';
import { findUnusedComponents } from '../../src/engine/audit';
import { getWorkspaceDatabase, closeWorkspaceDatabase, isWorkspaceIndexed, resolveIndexedWorkspaceRoot } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { prepareIndexedAnalysis } from '../../src/engine/prepare-index';
import { collectFiles } from '../../src/engine/collector';
import { scanRoutes } from '../../src/engine/routes';
import { resolveProjectRoot, setLastKnownProjectRoot } from '../../src/engine/path-resolver';
import { traceStateChain } from '../../src/engine/storage/state-chain';
import { formatStateChainAsText } from '../../src/engine/storage/state-format';
import { formatRoutesAsText } from '../../src/engine/routing/format';
import { queryFileStateDeps } from '../../src/engine/storage/state-impact';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Strata MCP Server Improvements Regression Suite', () => {
  // Item 7: Heuristic disclaimer on BackendTargetHint
  describe('Item 7: Route Heuristic Disclaimer', () => {
    it('attaches isHeuristic: true and explicit verification disclaimer to backendTargetHint', () => {
      const hint = synthesizeBackendTargetHint('POST', '/barang-masuk');
      expect(hint.isHeuristic).toBe(true);
      expect(hint.disclaimer).toContain('Pure Naming Convention Heuristic');
      expect(hint.disclaimer).toContain('routes/web.php');
      expect(hint.suggestedSymbols[0]).toBe('Barang-masukController');
    });

    it('attaches isHeuristic: true to Ziggy named route hints', () => {
      const hint = synthesizeBackendTargetHint('GET', "route('pembayaran.index')");
      expect(hint.isHeuristic).toBe(true);
      expect(hint.disclaimer).toContain('Pure Naming Convention Heuristic');
      expect(hint.suggestedSymbols[0]).toBe('PembayaranController');
    });
  });

  // Item 6: Fast Reverse Dependency Lookup & Bounded Limits
  describe('Item 6: Fast Reverse-Dependency Lookup via SQLite', () => {
    it('returns manually expected consumers from a prepared SQLite graph', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-improvements-'));
      try {
        const db = getWorkspaceDatabase(tempDir, { create: true });
        
        // Setup parent page and child button in SQLite graph DB
        const buttonPath = join(tempDir, 'src/components/AppButton.vue');
        const page1Path = join(tempDir, 'src/pages/Dashboard.vue');
        const page2Path = join(tempDir, 'src/pages/Penjualan.vue');
        mkdirSync(join(tempDir, 'src/components'), { recursive: true });
        mkdirSync(join(tempDir, 'src/pages'), { recursive: true });

        writeFileSync(buttonPath, '<template><button><slot /></button></template>');
        const page = '<script setup>import AppButton from "../components/AppButton.vue";</script><template><AppButton /></template>';
        writeFileSync(page1Path, page);
        writeFileSync(page2Path, page);
        await syncWorkspace(tempDir);
        expect(db.query('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 2 });
        const tree = await getUpwardComponentTree({
          entryPath: buttonPath,
          targetPath: tempDir,
          maxDepth: 1,
          limit: 20,
          skipSync: true,
        });
        expect(tree.direction).toBe('upward');
        expect(tree.root.children.length).toBe(2);
        const childrenPaths = tree.root.children.map(c => c.filePath);
        expect(childrenPaths).toContain(page1Path);
        expect(childrenPaths).toContain(page2Path);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces default limit 20 and reports has_more when consumers exceed limit', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-limits-'));
      try {
        getWorkspaceDatabase(tempDir, { create: true });
        const buttonPath = join(tempDir, 'src/components/AtomButton.vue');
        mkdirSync(join(tempDir, 'src/components'), { recursive: true });
        mkdirSync(join(tempDir, 'src/pages'), { recursive: true });
        writeFileSync(buttonPath, '<template><button /></template>');

        // The source fixture, rather than hand-written graph edges, establishes the oracle.
        for (let i = 1; i <= 25; i++) {
          const parentPath = join(tempDir, `src/pages/Page${i}.vue`);
          writeFileSync(parentPath, '<script setup>import AtomButton from "../components/AtomButton.vue";</script><template><AtomButton /></template>');
        }

        const tree = await getUpwardComponentTree({
          entryPath: buttonPath,
          targetPath: tempDir,
          limit: 20,
        });

        expect(tree.root.children.length).toBe(20);
        expect(tree.has_more).toBe(true);
        expect(tree.diagnostics?.some(d => d.code === 'UPWARD_RESULTS_TRUNCATED')).toBe(true);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch 1: Budget & Noise Fixes', () => {
    it('deduplicates omission codes in formatRetrievalEvidence', () => {
      const footer = formatRetrievalEvidence({
        version: 1,
        workspace: '/w',
        scope: '/w',
        queryId: 'q',
        retrievalId: 'r',
        policy: 'p',
        engineRevision: 'e',
        index: null,
        config: { applicability: 'not-used', reason: 'test' },
        freshness: 'current',
        freshnessBoundary: 'source-rechecked-after-selection',
        completeness: 'partial',
        basis: 'source',
        selectionReason: 'test',
        omissions: [
          { code: 'MAX_DEPTH_REACHED', reason: 'a' },
          { code: 'MAX_DEPTH_REACHED', reason: 'b' },
          { code: 'SOURCE_CHANGED', reason: 'c' },
        ],
        limitations: [],
      });
      expect(footer).toContain('omissions=MAX_DEPTH_REACHED,SOURCE_CHANGED');
    });

    it('aggregates repeated MAX_DEPTH_REACHED diagnostics in formatPatchPlanAsText', () => {
      const text = formatPatchPlanAsText({
        component: '/w/src/Button.vue',
        refactorType: 'rename_prop',
        oldName: 'size',
        newName: 'variant',
        totalConsumersAudited: 0,
        totalPatches: 0,
        preconditionsValidated: true,
        patches: [],
        coverage: {
          discovery: 'graph-bounded',
          candidateCount: 0,
          analyzedCount: 0,
          failedCount: 0,
          unsupportedCount: 0,
          truncated: false,
          diagnostics: Array.from({ length: 7 }, (_, i) => ({
            file: `/w/src/Page${i}.vue`,
            code: 'MAX_DEPTH_REACHED' as const,
            message: 'Traversal depth limit reached',
          })),
          omissions: [],
        },
        _meta: { version: '0.0.0' },
      } as any);
      const matches = text.match(/MAX_DEPTH_REACHED/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(text).toContain('7 node(s) not expanded');
      expect(text).toContain('and 2 more');
    });

    it('uses totalAvailable for Total API Invocations header when paginated', () => {
      const text = formatApiContractsAsText({
        workspaceRoot: '/w',
        totalEndpointsFound: 12,
        endpoints: [
          { method: 'GET', endpoint: '/api/users', clientKind: 'fetch', file: '/w/src/a.ts', line: 10 },
        ],
        totalAvailable: 93,
        endpointSummary: {
          '/api/users': { methods: ['GET'], callers: ['src/a.ts'] },
        },
        _meta: { version: '0.0.0' },
      } as any);
      expect(text).toContain('- **Total API Invocations:** 93');
    });
  });

  describe('Batch 2: Parser & Classification Fixes', () => {
    it('ignores Vue/Nuxt built-in tags in component tree and filters directives/key/ref from passedProps', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b2-vue-'));
      try {
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        const appPath = join(tempDir, 'src', 'App.vue');
        writeFileSync(
          appPath,
          `<template>
            <Teleport to="body"><Transition name="fade"><KeepAlive><Suspense><NuxtLink to="/">Home</NuxtLink></Suspense></KeepAlive></Transition></Teleport>
            <TransitionGroup tag="ul"><MyCard v-for="item in items" :key="item.id" :ref="setRef" v-if="show" :title="item.name" /></TransitionGroup>
          </template>`
        );
        const tree = await getComponentTree({ entryPath: appPath, targetPath: tempDir });
        const childNames = tree.root.children.map((c) => c.component);
        expect(childNames).not.toContain('Teleport');
        expect(childNames).not.toContain('Suspense');
        expect(childNames).not.toContain('KeepAlive');
        expect(childNames).not.toContain('Transition');
        expect(childNames).not.toContain('TransitionGroup');
        expect(childNames).not.toContain('NuxtLink');

        const props = extractPassedProps(
          `<template><MyCard v-for="item in items" :key="item.id" :ref="setRef" v-if="show" v-show="vis" :title="item.name" /></template>`,
          ['MyCard']
        );
        expect(props.map((p) => p.propName)).toEqual(['title']);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('excludes Pages/*/Partials and Pages/*/Components in isPageFile and deduplicates upward consumers', async () => {
      expect(isPageFile('/repo/resources/js/Pages/Users/Index.vue')).toBe(true);
      expect(isPageFile('/repo/resources/js/Pages/Users/Partials/UserForm.vue')).toBe(false);
      expect(isPageFile('/repo/resources/js/Pages/Users/Components/UserBadge.vue')).toBe(false);

      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b2-upward-'));
      try {
        mkdirSync(join(tempDir, 'src', 'components'), { recursive: true });
        const childPath = join(tempDir, 'src', 'components', 'Btn.vue');
        const parentPath = join(tempDir, 'src', 'Parent.vue');
        writeFileSync(childPath, '<template><button /></template>');
        writeFileSync(parentPath, `<template><Btn /></template><script setup>import Btn from './components/Btn.vue';</script>`);
        const db = getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);
        const childRow = db.query('SELECT id FROM files WHERE path = ?').get(childPath) as { id: number };
        const parentRow = db.query('SELECT id FROM files WHERE path = ?').get(parentPath) as { id: number };
        // Insert a second edge with a different import_type between the same parent and child
        db.prepare('INSERT INTO edges (parent_file_id, child_file_id, import_type, is_rendered) VALUES (?, ?, ?, ?)').run(
          parentRow.id,
          childRow.id,
          'dynamic',
          0
        );
        const tree = await getUpwardComponentTree({ entryPath: childPath, targetPath: tempDir, limit: 20 });
        const matches = tree.root.children.filter((c) => c.filePath === parentPath);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.isRendered).toBe(true);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('classifies React/TS directives, exports, JSX tags, and non-Next Server Actions accurately', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b2-react-'));
      try {
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        const barrelPath = join(tempDir, 'src', 'index.ts');
        const pagePath = join(tempDir, 'src', 'Page.tsx');
        writeFileSync(
          barrelPath,
          `'use client';\nimport { Badge } from './Badge';\nexport { Button } from './Button';\nexport const X = 1;\n`
        );
        writeFileSync(
          pagePath,
          `'use client';\nexport function Page() { return <div><button type="button">Native</button></div>; }\n`
        );

        const mapped = await mapSourceFile(barrelPath);
        expect(mapped.regions.find((r) => r.name === "'use client'")?.kind).toBe('directive');
        expect(mapped.regions.find((r) => r.name === "'./Button'")?.kind).toBe('export');
        expect(mapped.regions.find((r) => r.name === "'./Badge'")?.kind).toBe('import');

        const matches = await findComponentUsage({ targetPath: tempDir, componentName: 'Button' });
        expect(matches.some((m) => m.file === pagePath && m.usageKind === 'render')).toBe(false);
        const barrelMatch = matches.find((m) => m.file === barrelPath);
        expect(barrelMatch?.usageKind).toBe('export');

        const deps = extractDataDependencies(
          `export function Sidebar() { return <>{SidebarGroupAction({})} {SidebarMenuAction({})}</>; }`,
          'react'
        );
        expect(deps?.serverActions).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('supports Nuxt 4 app/components/ in frontend-map roleHint and dead-components audit', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b2-nuxt4-'));
      try {
        const compDir = join(tempDir, 'apps', 'control-panel', 'app', 'components');
        mkdirSync(compDir, { recursive: true });
        const btnPath = join(compDir, 'AppButton.vue');
        writeFileSync(btnPath, '<template><button><slot /></button></template>');

        const mapResult = await mapFrontendScope(tempDir);
        const mappedBtn = mapResult.files.find((f) => f.path === btnPath);
        expect(mappedBtn?.roleHint).toBe('component');

        const audit = await findUnusedComponents({ targetPath: tempDir });
        expect(audit.totalScanned).toBe(1);
        expect(audit.unusedComponents[0]?.name).toBe('AppButton');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch 3: Monorepo & State Indexing', () => {
    it('discovers parent monorepo .strata/ directory from sub-package target_path', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b3-walkup-'));
      try {
        const subAppDir = join(tempDir, 'apps', 'control-panel');
        mkdirSync(join(subAppDir, 'app', 'components'), { recursive: true });
        writeFileSync(join(subAppDir, 'app', 'components', 'Btn.vue'), '<template><button /></template>');

        getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);

        expect(isWorkspaceIndexed(subAppDir)).toBe(true);
        expect(resolveIndexedWorkspaceRoot(subAppDir)).toBe(resolveIndexedWorkspaceRoot(tempDir));
        const obs = await prepareIndexedAnalysis(subAppDir);
        expect(obs).not.toBeNull();
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('ignores .toolbench, isolates monorepo app boundaries, and keeps apps/<name>/ prefix on tree labels', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b3-mono-'));
      try {
        const saasComp = join(tempDir, 'apps', 'saas-admin', 'components', 'Sidebar.vue');
        const saasPage = join(tempDir, 'apps', 'saas-admin', 'pages', 'index.vue');
        const retailPage = join(tempDir, 'apps', 'retail-pos', 'pages', 'index.vue');
        const toolbenchFile = join(tempDir, '.toolbench', 'probe.ts');

        mkdirSync(join(tempDir, 'apps', 'saas-admin', 'components'), { recursive: true });
        mkdirSync(join(tempDir, 'apps', 'saas-admin', 'pages'), { recursive: true });
        mkdirSync(join(tempDir, 'apps', 'retail-pos', 'pages'), { recursive: true });
        mkdirSync(join(tempDir, '.toolbench'), { recursive: true });

        writeFileSync(saasComp, '<template><aside /></template>');
        writeFileSync(saasPage, '<template><Sidebar /></template>');
        writeFileSync(retailPage, '<template><Sidebar /></template>');
        writeFileSync(toolbenchFile, 'export const probe = 1;');

        const files = await collectFiles(tempDir);
        expect(files.some((f) => f.includes('.toolbench'))).toBe(false);

        const tree = await getUpwardComponentTree({ entryPath: saasComp, targetPath: tempDir });
        const consumerFiles = tree.root.children.map((c) => c.filePath);
        expect(consumerFiles).toContain(saasPage);
        expect(consumerFiles).not.toContain(retailPage);
        expect(tree.root.children[0]?.component).toBe('apps/saas-admin/index.vue');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch 4: Real-World Evaluation Bug Fixes', () => {
    it('detects Nuxt framework and routes from monorepo root and with scopePath', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b4-routes-'));
      try {
        const appDir = join(tempDir, 'apps', 'control-panel');
        mkdirSync(join(appDir, 'app', 'pages'), { recursive: true });
        writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'monorepo', private: true }));
        writeFileSync(join(appDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});');
        writeFileSync(join(appDir, 'app', 'pages', 'index.vue'), '<template><div>Home</div></template>');
        writeFileSync(join(appDir, 'app', 'pages', 'billing.vue'), '<template><div>Billing</div></template>');

        const mapped = await mapFrontendScope(tempDir);
        expect(mapped.frameworkCandidates.some((f) => f.name === 'nuxt')).toBe(true);

        const rootRoutes = await scanRoutes({ targetPath: tempDir });
        expect(rootRoutes.totalRoutes).toBe(2);

        const scopedRoutes = await scanRoutes({ targetPath: tempDir, scopePath: 'apps/control-panel' });
        expect(scopedRoutes.totalRoutes).toBe(2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('resolveProjectRoot(".") does not silently reuse lastKnownProjectRoot', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b4-root-'));
      try {
        setLastKnownProjectRoot(tempDir);
        const resolved = resolveProjectRoot('.');
        expect(resolved).not.toBe(tempDir);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('isolates traceStateChain consumers and depth-2 edges to requested monorepo app boundary', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b4-state-'));
      try {
        const cpDir = join(tempDir, 'apps', 'control-panel');
        const fnbDir = join(tempDir, 'apps', 'fnb-pos');
        mkdirSync(join(cpDir, 'app', 'composables'), { recursive: true });
        mkdirSync(join(cpDir, 'app', 'pages'), { recursive: true });
        mkdirSync(join(fnbDir, 'app', 'composables'), { recursive: true });
        mkdirSync(join(fnbDir, 'app', 'pages'), { recursive: true });

        writeFileSync(join(cpDir, 'app', 'composables', 'useAuth.ts'), 'export function useAuth() { return { login: () => {} }; }');
        writeFileSync(join(cpDir, 'app', 'pages', 'index.vue'), `<template><div /></template><script setup lang="ts">\nconst auth = useAuth();\n</script>`);
        writeFileSync(join(fnbDir, 'app', 'composables', 'useAuth.ts'), 'export function useAuth() { return { login: () => {} }; }');
        writeFileSync(join(fnbDir, 'app', 'pages', 'cashier.vue'), `<template><div /></template><script setup lang="ts">\nconst auth = useAuth();\n</script>`);

        getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);

        const chain = await traceStateChain(cpDir, { identifier: 'useAuth', maxDepth: 2, direction: 'both' });
        expect(chain.consumers.every((c) => c.filePath.startsWith(cpDir))).toBe(true);
        expect(chain.consumers.some((c) => c.filePath.startsWith(fnbDir))).toBe(false);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('preserves earliest script line number in getFileStateDependencies instead of template write line', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b4-line-'));
      try {
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        const pagePath = join(tempDir, 'src', 'Cashier.vue');
        const padding = Array.from({ length: 15 }, () => '<div>line</div>').join('\n');
        writeFileSync(
          pagePath,
          `<script setup lang="ts">\n// header\nconst tx = useTransactions();\n</script>\n<template>\n${padding}\n<button @click="tx.submit()">Save</button>\n</template>`
        );

        getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);

        const fileDeps = await queryFileStateDeps(tempDir, pagePath);
        const txDep = fileDeps.dependencies.find((d) => d.identifier === 'useTransactions');
        expect(txDep?.role).toBe('mutator');
        expect(txDep?.lineNumber).toBe(3);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('matches double-quoted component imports as [import] in findComponentUsage', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b4-import-'));
      try {
        mkdirSync(join(tempDir, 'app', 'components'), { recursive: true });
        const formPath = join(tempDir, 'app', 'components', 'ProductForm.vue');
        writeFileSync(
          formPath,
          `<template><AppButton /></template>\n<script setup lang="ts">\nimport AppButton from "~/components/ui/AppButton.vue";\n</script>`
        );

        const matches = await findComponentUsage({ targetPath: tempDir, componentName: 'AppButton' });
        expect(matches.some((m) => m.file === formPath && m.usageKind === 'import')).toBe(true);
        expect(matches.some((m) => m.file === formPath && m.usageKind === 'render')).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch 5: Evaluation Follow-up Fixes', () => {
    it('preserves full relative path under apps/<name>/ in upward component tree labels', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b5-upward-'));
      try {
        const uiDir = join(tempDir, 'apps', 'control-panel', 'app', 'components', 'ui');
        const dashDir = join(tempDir, 'apps', 'control-panel', 'app', 'components', 'dashboard');
        mkdirSync(uiDir, { recursive: true });
        mkdirSync(dashDir, { recursive: true });

        const targetPath = join(uiDir, 'ResponsiveTable.vue');
        const consumerPath = join(dashDir, 'ActiveServicesTable.vue');
        writeFileSync(targetPath, '<template><table><slot /></table></template>');
        writeFileSync(
          consumerPath,
          '<template><ResponsiveTable /></template>\n<script setup lang="ts">\nimport ResponsiveTable from "../ui/ResponsiveTable.vue";\n</script>'
        );

        const tree = await getUpwardComponentTree({ entryPath: targetPath, targetPath: tempDir, depth: 2 });
        expect(tree.root.children.some((c) => c.component === 'apps/control-panel/app/components/dashboard/ActiveServicesTable.vue')).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('classifies init/load/fetch composable calls as mutator and shows [mutator] role at depth 2', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b5-state-'));
      try {
        const compDir = join(tempDir, 'apps', 'fnb-pos', 'app', 'composables');
        const pageDir = join(tempDir, 'apps', 'fnb-pos', 'app', 'pages');
        mkdirSync(compDir, { recursive: true });
        mkdirSync(pageDir, { recursive: true });

        writeFileSync(
          join(compDir, 'useAttendance.ts'),
          'export const useAttendance = () => ({ status: ref("idle"), initAttendanceSession: () => {} });'
        );
        writeFileSync(
          join(pageDir, 'index.vue'),
          `<template><div>{{ status }}</div></template>\n<script setup lang="ts">\nconst { status, initAttendanceSession } = useAttendance();\ninitAttendanceSession();\n</script>`
        );
        writeFileSync(
          join(pageDir, 'readonly.vue'),
          `<template><div>{{ status }}</div></template>\n<script setup lang="ts">\nconst { status } = useAttendance();\n</script>`
        );

        const db = getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);

        const chain = await traceStateChain(tempDir, {
          identifier: 'useAttendance',
          maxDepth: 2,
          direction: 'both',
        });
        expect(chain).not.toBeNull();
        const mutatorNode = chain.consumers.find((c) => c.filePath.endsWith('index.vue'));
        const readerNode = chain.consumers.find((c) => c.filePath.endsWith('readonly.vue'));
        expect(mutatorNode?.role).toBe('mutator');
        expect(readerNode?.role).toBe('reader');

        const formatted = formatStateChainAsText(chain);
        expect(formatted).toContain('[mutator]');
        expect(formatted).toContain('[reader]');
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('annotates monorepo app badges in formatRoutesAsText', () => {
      const text = formatRoutesAsText({
        framework: 'nuxt',
        baseDirectory: 'apps',
        totalRoutes: 2,
        routes: [
          { routePath: '/cashier', filePath: 'apps/retail-pos/app/pages/cashier/index.vue', routeType: 'page', isDynamic: false, params: [] },
          { routePath: '/cashier', filePath: 'apps/fnb-pos/app/pages/cashier/index.vue', routeType: 'page', isDynamic: false, params: [] },
        ],
      });
      expect(text).toContain('[apps/retail-pos]');
      expect(text).toContain('[apps/fnb-pos]');
    });

    it('splits direct children of a >50-line root template element in mapSourceFile when no semantic regions exist', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b5-template-'));
      try {
        const longFile = join(tempDir, 'LongTable.vue');
        const filler = Array.from({ length: 28 }, (_, i) => `      <span>row ${i}</span>`).join('\n');
        writeFileSync(
          longFile,
          `<template>\n  <div class="wrapper">\n    <div class="desktop">\n${filler}\n    </div>\n    <div class="mobile">\n${filler}\n    </div>\n  </div>\n</template>\n<script setup lang="ts">\nconst count = 1;\n</script>`
        );

        const longMap = await mapSourceFile(longFile);
        const longTemplateBlock = longMap.regions.find((r) => r.name === 'template');
        const longRootElem = longTemplateBlock?.children?.[0];
        expect(longRootElem?.kind).toBe('template-region');
        expect(longRootElem?.children?.length).toBe(2);

        const shortFile = join(tempDir, 'ShortTable.vue');
        writeFileSync(
          shortFile,
          `<template>\n  <div class="wrapper">\n    <div class="desktop"><span>a</span></div>\n    <div class="mobile"><span>b</span></div>\n  </div>\n</template>`
        );
        const shortMap = await mapSourceFile(shortFile);
        const shortTemplateBlock = shortMap.regions.find((r) => r.name === 'template');
        const shortRootElem = shortTemplateBlock?.children?.[0];
        expect(shortRootElem?.kind).toBe('template-region');
        expect(shortRootElem?.children).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch 6: Evaluation Follow-up Fixes', () => {
    it('does not parse v-else followed by :item on next line as a prop binding in Vue SFC', () => {
      const sfc = `<template>\n  <div v-if="loading">Loading</div>\n  <DataCard v-else\n    :item="item"\n    title="Info" />\n</template>\n<script setup lang="ts">\nconst loading = false;\n</script>`;
      const props = extractPassedProps(sfc, ['DataCard']);
      expect(props.map((p) => p.propName)).toEqual(['item', 'title']);
    });

    it('does not label ClientOnly or static library tags as Dynamic component rendered via variable/computed', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b6-tree-'));
      try {
        const pagePath = join(tempDir, 'index.vue');
        writeFileSync(
          pagePath,
          `<template>\n  <ClientOnly>\n    <Percent class="w-4 h-4" />\n    <Bar :data="chartData" />\n  </ClientOnly>\n</template>\n<script setup lang="ts">\nimport { Percent } from 'lucide-vue-next';\nimport { Bar } from 'vue-chartjs';\nconst chartData = {};\n</script>`
        );
        const tree = await getComponentTree({ entryPath: pagePath, targetPath: tempDir, depth: 2 });
        const hasBogusDynamic = tree.root.children.some((c) =>
          (c.warning || '').includes('Dynamic component rendered via variable/computed')
        );
        expect(hasBogusDynamic).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('classifies logout()/login() composable calls as mutator and includes Nuxt useState in internal dependencies', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-b6-state-'));
      try {
        const appDir = join(tempDir, 'apps', 'control-panel');
        const compDir = join(appDir, 'app', 'composables');
        const compUiDir = join(appDir, 'app', 'components');
        mkdirSync(compDir, { recursive: true });
        mkdirSync(compUiDir, { recursive: true });
        writeFileSync(join(appDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});');

        writeFileSync(
          join(compDir, 'useAuth.ts'),
          `export const useAuth = () => {\n  const user = useState<string | null>('auth_user', () => null);\n  const cookie = useCookie('token');\n  const logout = () => { user.value = null; };\n  return { user, cookie, logout };\n};`
        );
        writeFileSync(
          join(compUiDir, 'Header.vue'),
          `<template><button @click="logout">Out</button></template>\n<script setup lang="ts">\nconst { user, logout } = useAuth();\nfunction handleOut() { logout(); }\n</script>`
        );

        getWorkspaceDatabase(tempDir, { create: true });
        await syncWorkspace(tempDir);

        const chain = await traceStateChain(tempDir, {
          identifier: 'useAuth',
          maxDepth: 2,
          direction: 'both',
        });
        const headerNode = chain.consumers.find((c) => c.filePath.endsWith('Header.vue'));
        expect(headerNode?.role).toBe('mutator');
        expect(chain.dependencies.some((d) => d.identifier === 'useState')).toBe(true);
      } finally {
        closeWorkspaceDatabase(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('surfaces definePageMeta alias in formatRoutesAsText', () => {
      const text = formatRoutesAsText({
        framework: 'nuxt',
        baseDirectory: 'apps',
        totalRoutes: 1,
        routes: [
          {
            routePath: '/auth/login',
            filePath: 'apps/retail-pos/app/pages/auth/login.vue',
            routeType: 'page',
            isDynamic: false,
            params: [],
            nuxtPageMeta: { alias: ['/login'], customMetaKeys: ['alias'] },
          },
        ],
      });
      expect(text).toContain('Aliases: /login');
    });

    it('suppresses Backend Target Hint for non-inertia-route calls in formatApiContractsAsText', () => {
      const text = formatApiContractsAsText({
        totalEndpoints: 2,
        endpoints: [
          {
            file: '/app/pages/index.vue',
            line: 10,
            column: 1,
            endpoint: '/api/v1/vendors',
            method: 'GET',
            clientKind: '$fetch',
            backendTargetHint: synthesizeBackendTargetHint('GET', '/api/v1/vendors'),
          },
          {
            file: '/app/pages/orders.vue',
            line: 12,
            column: 1,
            endpoint: 'orders.store',
            method: 'POST',
            clientKind: 'custom',
            backendTargetHint: synthesizeBackendTargetHint('POST', 'orders.store'),
          },
        ],
        endpointSummary: {
          '/api/v1/vendors': { methods: ['GET'], callers: ['index.vue'] },
          'orders.store': { methods: ['POST'], callers: ['orders.vue'] },
        },
      });
      expect(text).not.toContain('VendorsController');
      expect(text).toContain('Backend Target Hint');
    });
  });
});
