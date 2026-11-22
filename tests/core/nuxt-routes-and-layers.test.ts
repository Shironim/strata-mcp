import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFilesWithReport } from '../../src/engine/collector';
import { scanRoutes } from '../../src/engine/routes';
import { defaultWarmDbPool, mapWorkspace, SemanticProjectPool } from '../../src/engine/v2';

describe('Fase 2: Nuxt Route Collector & Layers Scanner', () => {
  test('includes app/pages/docs/** and layers/**/pages/** in scanRoutes and mapWorkspace(routes) while still ignoring root docs/', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-nuxt-routes-'));
    const semanticPool = new SemanticProjectPool({ maxActiveProjects: 2 });

    try {
      await mkdir(join(workDir, 'docs'), { recursive: true });
      await mkdir(join(workDir, 'app/pages/docs/[version]/errors'), { recursive: true });
      await mkdir(join(workDir, 'app/layouts'), { recursive: true });
      await mkdir(join(workDir, 'layers/nuxi/app/pages/dashboard/chat'), { recursive: true });
      await mkdir(join(workDir, 'layers/nuxi/server/api'), { recursive: true });
      await mkdir(join(workDir, 'custom-layer/pages'), { recursive: true });

      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'nuxt-routes-fixture', private: true, dependencies: { nuxt: '^3.14.0' } })
      );
      await writeFile(
        join(workDir, 'nuxt.config.ts'),
        `export default defineNuxtConfig({\n  extends: ['./custom-layer'],\n});\n`
      );

      // Root non-code docs folder should still be ignored by default collector
      await writeFile(join(workDir, 'docs/DocScratch.vue'), '<template><div>Non-code doc</div></template>\n');

      // Root pages including docs/** and an override for /shared
      await writeFile(join(workDir, 'app/layouts/default.vue'), '<template><slot /></template>\n');
      await writeFile(join(workDir, 'app/pages/index.vue'), '<template><div>Home</div></template>\n');
      await writeFile(join(workDir, 'app/pages/shared.vue'), '<template><div>Root Shared</div></template>\n');
      await writeFile(join(workDir, 'app/pages/docs/[...slug].vue'), '<template><div>Docs Slug</div></template>\n');
      await writeFile(
        join(workDir, 'app/pages/docs/[version]/errors/index.vue'),
        '<template><div>Errors</div></template>\n'
      );

      // Auto-discovered layer under layers/nuxi
      await writeFile(
        join(workDir, 'layers/nuxi/app/pages/dashboard/chat/index.vue'),
        '<template><div>Chat Index</div></template>\n'
      );
      await writeFile(
        join(workDir, 'layers/nuxi/app/pages/dashboard/chat/[id].vue'),
        '<template><div>Chat Detail</div></template>\n'
      );
      // Should be overridden by root app/pages/shared.vue
      await writeFile(
        join(workDir, 'layers/nuxi/app/pages/shared.vue'),
        '<template><div>Layer Shared</div></template>\n'
      );
      await writeFile(
        join(workDir, 'layers/nuxi/server/api/chat.post.ts'),
        'export default defineEventHandler(() => ({ ok: true }));\n'
      );

      // Explicit layer via nuxt.config.ts extends
      await writeFile(join(workDir, 'custom-layer/pages/changelog.vue'), '<template><div>Changelog</div></template>\n');

      // 1. Collector still ignores top-level docs/ while collecting app/pages/docs/**
      const collectReport = await collectFilesWithReport(workDir);
      expect(collectReport.files.some((f) => f.endsWith('app/pages/docs/[...slug].vue'))).toBe(true);
      expect(collectReport.files.some((f) => f.endsWith('docs/DocScratch.vue'))).toBe(false);
      expect(collectReport.excludedDirs).toContainEqual({ path: 'docs', reason: 'default-ignore' });

      // 2. scanRoutes discovers all pages across root + layers + extends + nitro APIs
      const manifest = await scanRoutes({ targetPath: workDir });
      expect(manifest.framework).toBe('nuxt');

      const routePaths = manifest.routes.map((r) => `${r.type}:${r.path}`);
      expect(routePaths).toContain('page:/');
      expect(routePaths).toContain('page:/docs/[...slug]');
      expect(routePaths).toContain('page:/docs/[version]/errors');
      expect(routePaths).toContain('page:/dashboard/chat');
      expect(routePaths).toContain('page:/dashboard/chat/[id]');
      expect(routePaths).toContain('page:/changelog');
      expect(routePaths).toContain('api:/api/chat');

      // App-over-layer precedence: /shared points to root app/pages/shared.vue
      const sharedRoute = manifest.routes.find((r) => r.type === 'page' && r.path === '/shared');
      expect(sharedRoute?.filePath.replace(/\\/g, '/')).toEndWith('app/pages/shared.vue');

      // 3. End-to-end via SQLite V3 mapWorkspace(view: 'routes')
      const routesRes = await mapWorkspace({
        workspaceRoot: workDir,
        view: 'routes',
        semanticPool,
      });
      const indexedRelPaths = (routesRes.data.routes ?? []).map((r) => r.relPath);
      expect(indexedRelPaths).toContain('app/pages/docs/[...slug].vue');
      expect(indexedRelPaths).toContain('app/pages/docs/[version]/errors/index.vue');
      expect(indexedRelPaths).toContain('layers/nuxi/app/pages/dashboard/chat/index.vue');
      expect(indexedRelPaths).toContain('layers/nuxi/app/pages/dashboard/chat/[id].vue');
      expect(indexedRelPaths).toContain('custom-layer/pages/changelog.vue');
      expect(indexedRelPaths).toContain('layers/nuxi/server/api/chat.post.ts');
    } finally {
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('detects Nuxt framework when pages exist only inside layers/', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-nuxt-layer-only-'));
    try {
      await mkdir(join(workDir, 'layers/base/app/pages'), { recursive: true });
      await writeFile(join(workDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});\n');
      await writeFile(join(workDir, 'layers/base/app/pages/health.vue'), '<template><div>OK</div></template>\n');

      const manifest = await scanRoutes({ targetPath: workDir });
      expect(manifest.framework).toBe('nuxt');
      expect(manifest.routes.map((r) => r.path)).toContain('/health');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
