import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultWarmDbPool,
  deriveComponentNames,
  mapWorkspace,
  queryGraph,
  searchCode,
  SemanticProjectPool,
  stripLazyComponentPrefix,
  syncDirtyFilesV3,
  syncWorkspaceV3,
} from '../../src/engine/v2';

describe('Fase 1: Nuxt Auto-Import Graph Linker & Regression Suite', () => {
  test('deriveComponentNames and stripLazyComponentPrefix follow Nuxt conventions', () => {
    expect(deriveComponentNames('app/components/home/HomeLogoCarousel.vue', 'HomeLogoCarousel')).toEqual({
      primary: 'HomeLogoCarousel',
      fallbacks: [],
    });
    expect(deriveComponentNames('app/components/home/LogoCarousel.vue', 'LogoCarousel')).toEqual({
      primary: 'HomeLogoCarousel',
      fallbacks: ['LogoCarousel'],
    });
    expect(deriveComponentNames('app/components/ui/button/index.vue', 'index')).toEqual({
      primary: 'UiButton',
      fallbacks: ['Button'],
    });
    expect(deriveComponentNames('layers/nuxi/app/components/ChatPanel.vue', 'ChatPanel')).toEqual({
      primary: 'ChatPanel',
      fallbacks: [],
    });
    expect(stripLazyComponentPrefix('LazyDocsL10nEditor')).toBe('DocsL10nEditor');
    expect(stripLazyComponentPrefix('Lazy')).toBeNull();
    expect(stripLazyComponentPrefix('Lazyness')).toBeNull();
  });

  test('resolves componentUsage, propUsage, bidirectional componentTree, impact, and Lazy* auto-imports consistently', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-nuxt-autoimport-'));
    const semanticPool = new SemanticProjectPool({ maxActiveProjects: 2 });

    try {
      await mkdir(join(workDir, 'app/components/home'), { recursive: true });
      await mkdir(join(workDir, 'app/components/ui/button'), { recursive: true });
      await mkdir(join(workDir, 'app/pages'), { recursive: true });

      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'nuxt-eval-fixture', private: true, dependencies: { nuxt: '^3.14.0' } })
      );
      await writeFile(join(workDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});\n');
      await writeFile(
        join(workDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext' } })
      );

      await writeFile(
        join(workDir, 'app/components/home/HomeLogoCarousel.vue'),
        `<script setup lang="ts">
export interface Company { name: string }
defineProps<{ companies: Company[] }>();
</script>
<template>
  <div class="carousel">{{ companies.length }}</div>
</template>
`
      );

      await writeFile(
        join(workDir, 'app/components/home/HomeSectionContributors.vue'),
        `<template>
  <section class="contributors">Contributors</section>
</template>
`
      );

      await writeFile(
        join(workDir, 'app/components/DocsL10nEditor.vue'),
        `<script setup lang="ts">
defineProps<{ open?: boolean }>();
</script>
<template>
  <div>Editor</div>
</template>
`
      );

      await writeFile(
        join(workDir, 'app/components/ui/button/index.vue'),
        `<script setup lang="ts">
defineProps<{ label: string }>();
</script>
<template>
  <button>{{ label }}</button>
</template>
`
      );

      await writeFile(
        join(workDir, 'app/components/DocsL10nStatus.vue'),
        `<template>
  <div>
    <LazyDocsL10nEditor :open="true" />
    <UiButton label="Save" />
  </div>
</template>
`
      );

      await writeFile(
        join(workDir, 'app/pages/index.vue'),
        `<script setup lang="ts">
const companies = [{ name: 'Nuxt' }];
</script>
<template>
  <main>
    <HomeLogoCarousel :companies="companies" />
    <HomeSectionContributors />
    <DocsL10nStatus />
  </main>
</template>
`
      );

      const opts = { semanticPool };

      // 1. search_code: componentUsage & propUsage
      const compUsage = await searchCode({
        workspaceRoot: workDir,
        kind: 'componentUsage',
        query: 'HomeLogoCarousel',
        ...opts,
      });
      expect(compUsage.data.matches.some((m) => m.relPath === 'app/pages/index.vue')).toBe(true);

      const propUsage = await searchCode({
        workspaceRoot: workDir,
        kind: 'propUsage',
        query: 'companies',
        skipSync: true,
        ...opts,
      });
      expect(propUsage.data.matches.some((m) => m.relPath === 'app/pages/index.vue')).toBe(true);

      // 2. componentTree: bidirectional symmetry (up from child & down from page)
      const treeUp = await queryGraph({
        workspaceRoot: workDir,
        query: 'componentTree',
        target: { file: 'app/components/home/HomeLogoCarousel.vue' },
        direction: 'up',
        skipSync: true,
        ...opts,
      });
      expect(treeUp.data.tree?.children.map((c) => c.relPath)).toContain('app/pages/index.vue');

      const treeDown = await queryGraph({
        workspaceRoot: workDir,
        query: 'componentTree',
        target: { file: 'app/pages/index.vue' },
        direction: 'down',
        skipSync: true,
        ...opts,
      });
      const childRelPaths = treeDown.data.tree?.children.map((c) => c.relPath).sort();
      expect(childRelPaths).toEqual([
        'app/components/DocsL10nStatus.vue',
        'app/components/home/HomeLogoCarousel.vue',
        'app/components/home/HomeSectionContributors.vue',
      ]);

      // 3. impact: must find auto-imported consumer index.vue for prop `companies`
      const impactCarousel = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/home/HomeLogoCarousel.vue', member: 'companies' },
        skipSync: true,
        ...opts,
      });
      expect(impactCarousel.data.items?.map((i) => i.relPath)).toContain('app/pages/index.vue');
      expect(impactCarousel.data.items?.[0]?.kind).toBe('component-member:companies');

      // 4. Lazy* prefix and directory/index.vue auto-imports
      const impactLazy = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/DocsL10nEditor.vue', member: 'open' },
        skipSync: true,
        ...opts,
      });
      expect(impactLazy.data.items?.map((i) => i.relPath)).toContain('app/components/DocsL10nStatus.vue');

      const impactUiButton = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/ui/button/index.vue', member: 'label' },
        skipSync: true,
        ...opts,
      });
      expect(impactUiButton.data.items?.map((i) => i.relPath)).toContain('app/components/DocsL10nStatus.vue');

      // 5. health: DocsL10nEditor.vue & HomeLogoCarousel.vue must NOT be flagged as unused
      const health = await mapWorkspace({
        workspaceRoot: workDir,
        view: 'health',
        skipSync: true,
        ...opts,
      });
      const unusedRelPaths = (health.data.health?.unusedComponents ?? []).map((c) => c.relPath);
      expect(unusedRelPaths).not.toContain('app/components/DocsL10nEditor.vue');
      expect(unusedRelPaths).not.toContain('app/components/home/HomeLogoCarousel.vue');
      expect(unusedRelPaths).not.toContain('app/components/ui/button/index.vue');
    } finally {
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('preserves and re-links edges across target component edits, deletions, and incremental additions', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-nuxt-incremental-'));
    const semanticPool = new SemanticProjectPool({ maxActiveProjects: 2 });

    try {
      await mkdir(join(workDir, 'app/components'), { recursive: true });
      await mkdir(join(workDir, 'app/pages'), { recursive: true });

      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'nuxt-incr-fixture', private: true, dependencies: { nuxt: '^3.14.0' } })
      );
      await writeFile(join(workDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});\n');

      const badgePath = join(workDir, 'app/components/StatusBadge.vue');
      await writeFile(
        badgePath,
        `<script setup lang="ts">
defineProps<{ text: string }>();
</script>
<template><span>{{ text }}</span></template>
`
      );

      await writeFile(
        join(workDir, 'app/pages/home.vue'),
        `<template>
  <div>
    <StatusBadge text="ok" />
    <FutureBanner title="hi" />
  </div>
</template>
`
      );

      const db = defaultWarmDbPool.get(workDir);
      await syncWorkspaceV3(workDir, { db });

      // Edit StatusBadge.vue (re-inserts its symbols) -> home.vue edge must NOT be cascade-deleted
      await writeFile(
        badgePath,
        `<script setup lang="ts">
defineProps<{ text: string; tone?: string }>();
</script>
<template><span :data-tone="tone">{{ text }}</span></template>
`
      );
      await syncDirtyFilesV3(workDir, [badgePath], { db });

      const impactAfterEdit = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/StatusBadge.vue', member: 'text' },
        skipSync: true,
        db,
        semanticPool,
      });
      expect(impactAfterEdit.data.items?.map((i) => i.relPath)).toContain('app/pages/home.vue');

      // Add FutureBanner.vue later -> pre-existing unlinked edge in home.vue must auto-link!
      const bannerPath = join(workDir, 'app/components/FutureBanner.vue');
      await writeFile(
        bannerPath,
        `<script setup lang="ts">
defineProps<{ title: string }>();
</script>
<template><div>{{ title }}</div></template>
`
      );
      await syncDirtyFilesV3(workDir, [bannerPath], { db });

      const impactBanner = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/FutureBanner.vue', member: 'title' },
        skipSync: true,
        db,
        semanticPool,
      });
      expect(impactBanner.data.items?.map((i) => i.relPath)).toContain('app/pages/home.vue');

      // Delete StatusBadge.vue, sync, then recreate StatusBadge.vue -> edge preserved and re-linked
      await unlink(badgePath);
      await syncDirtyFilesV3(workDir, [badgePath], { db });

      await writeFile(
        badgePath,
        `<script setup lang="ts">
defineProps<{ text: string }>();
</script>
<template><span>{{ text }}</span></template>
`
      );
      await syncDirtyFilesV3(workDir, [badgePath], { db });

      const impactAfterRecreate = await queryGraph({
        workspaceRoot: workDir,
        query: 'impact',
        target: { file: 'app/components/StatusBadge.vue', member: 'text' },
        skipSync: true,
        db,
        semanticPool,
      });
      expect(impactAfterRecreate.data.items?.map((i) => i.relPath)).toContain('app/pages/home.vue');
    } finally {
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
