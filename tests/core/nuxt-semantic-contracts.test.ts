import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultWarmDbPool,
  inspectFile,
  mapWorkspace,
  queryGraph,
  SemanticProjectPool,
} from '../../src/engine/v2';

describe('Fase 3: Semantic Extraction, Vue Contract, State Flow & Backend Hints', () => {
  test('extracts Vue emits/models, preserves | null without .nuxt, resolves backendTargetHint, excludes app.vue from health, and tracks composable calls + useState', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-nuxt-fase3-'));
    const semanticPool = new SemanticProjectPool({ maxActiveProjects: 2 });

    try {
      await mkdir(join(workDir, 'app/components'), { recursive: true });
      await mkdir(join(workDir, 'app/composables'), { recursive: true });
      await mkdir(join(workDir, 'app/pages'), { recursive: true });
      await mkdir(join(workDir, 'server/api/nuxters'), { recursive: true });
      await mkdir(join(workDir, 'server/api/users'), { recursive: true });

      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'nuxt-fase3-fixture', private: true, dependencies: { nuxt: '^3.14.0' } })
      );
      await writeFile(join(workDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});\n');
      // Deliberately extends missing ./.nuxt/tsconfig.json to simulate un-prepared checkout
      await writeFile(
        join(workDir, 'tsconfig.json'),
        JSON.stringify({ extends: './.nuxt/tsconfig.json' })
      );

      await writeFile(
        join(workDir, 'app/app.vue'),
        '<template><NuxtPage /></template>\n'
      );

      await writeFile(
        join(workDir, 'app/components/DocsL10nStatus.vue'),
        `<script setup lang="ts">
interface TargetInfo { locale: string }
defineProps<{ target: TargetInfo | null; title?: string }>();
const emit = defineEmits<{
  (e: 'published', locale: string): void;
  close: [];
}>();
const show = defineModel<boolean>('show');
</script>
<template>
  <div v-if="show">{{ target?.locale }}</div>
</template>
`
      );

      await writeFile(
        join(workDir, 'server/api/nuxters/index.get.ts'),
        'export default defineEventHandler(() => []);\n'
      );
      await writeFile(
        join(workDir, 'server/api/users/[id].get.ts'),
        'export default defineEventHandler(() => ({}));\n'
      );

      await writeFile(
        join(workDir, 'app/components/HomeSectionContributors.vue'),
        `<script setup lang="ts">
const { data } = await useFetch('/api/nuxters');
const user = await $fetch(\`/api/users/\${123}\`);
</script>
<template><div>{{ data }} {{ user }}</div></template>
`
      );

      await writeFile(
        join(workDir, 'app/composables/useClipboard.ts'),
        `export function useClipboard() {
  const toast = useToast();
  return { copy: () => toast.add({ title: 'Copied' }) };
}
`
      );

      await writeFile(
        join(workDir, 'app/pages/changelog.vue'),
        `<script setup lang="ts">
const { copy } = useClipboard();
</script>
<template><button @click="copy">Copy</button></template>
`
      );

      await writeFile(
        join(workDir, 'app/composables/useNuxtBirthday.ts'),
        `export function useNuxtBirthday() {
  const isBirthday = useState('isBirthday', () => false);
  const birthdayAlias = useState('nuxt-birthday', () => false);
  function trigger() {
    isBirthday.value = true;
    birthdayAlias.value = true;
    return isBirthday.value && birthdayAlias.value;
  }
  return { isBirthday, trigger, active: isBirthday.value };
}
`
      );

      await writeFile(
        join(workDir, 'app/components/DocsProseImg.vue'),
        '<template><img /></template>\n'
      );
      await writeFile(
        join(workDir, 'app/components/DocsProseVideo.vue'),
        '<template><video /></template>\n'
      );
      await writeFile(
        join(workDir, 'app/components/ModuleDocsPage.vue'),
        `<script setup lang="ts">
import { DocsProseImg } from '#components';
const mdcComponents = {
  ProseImg: DocsProseImg,
  ProseVideo: DocsProseVideo,
};
</script>
<template><div :data-comps="Object.keys(mdcComponents).length" /></template>
`
      );

      const opts = { semanticPool };

      // 1. Vue contract: props preserves `| null`, emits includes `published` & `close`, models includes `show`
      const statusInspect = await inspectFile({
        workspaceRoot: workDir,
        path: 'app/components/DocsL10nStatus.vue',
        sections: ['contract'],
        ...opts,
      });
      const targetProp = statusInspect.data.contract?.props.find((p) => p.name === 'target');
      expect(targetProp?.type).toContain('null');
      expect(statusInspect.data.contract?.emits).toEqual(['published', 'close']);
      expect(statusInspect.data.contract?.models).toEqual([
        { name: 'show', type: 'boolean', required: false },
      ]);

      // 2. backendTargetHint on outboundHttp
      const contribInspect = await inspectFile({
        workspaceRoot: workDir,
        path: 'app/components/HomeSectionContributors.vue',
        sections: ['boundaries'],
        skipSync: true,
        ...opts,
      });
      const nuxtersCall = contribInspect.data.boundaries?.outboundHttp.find((b) =>
        b.url.includes('/api/nuxters')
      );
      expect(nuxtersCall?.backendTargetHint?.relPath).toBe('server/api/nuxters/index.get.ts');
      const userCall = contribInspect.data.boundaries?.outboundHttp.find((b) =>
        b.url.includes('/api/users/')
      );
      expect(userCall?.backendTargetHint?.relPath).toBe('server/api/users/[id].get.ts');

      // 3. Health audit excludes app/app.vue
      const health = await mapWorkspace({
        workspaceRoot: workDir,
        view: 'health',
        skipSync: true,
        ...opts,
      });
      const unusedRelPaths = (health.data.health?.unusedComponents ?? []).map((c) => c.relPath);
      expect(unusedRelPaths).not.toContain('app/app.vue');
      expect(unusedRelPaths).not.toContain('app/components/DocsProseImg.vue');
      expect(unusedRelPaths).not.toContain('app/components/DocsProseVideo.vue');

      // 4. callHierarchy for auto-imported useClipboard finds both caller (changelog.vue) and callee (useToast)
      const callHier = await queryGraph({
        workspaceRoot: workDir,
        query: 'callHierarchy',
        target: { file: 'app/composables/useClipboard.ts', symbol: 'useClipboard' },
        direction: 'both',
        skipSync: true,
        ...opts,
      });
      const callKinds = callHier.data.items?.map((i) => `${i.relPath}:${i.kind}`) ?? [];
      expect(callKinds).toContain('app/pages/changelog.vue:caller:calls');
      expect(callKinds).toContain('app/composables/useClipboard.ts:callee:calls:useToast');

      // 4b. references for auto-imported useClipboard also finds changelog.vue without .nuxt/imports.d.ts
      const refsRes = await queryGraph({
        workspaceRoot: workDir,
        query: 'references',
        target: { file: 'app/composables/useClipboard.ts', symbol: 'useClipboard' },
        skipSync: true,
        ...opts,
      });
      expect(refsRes.data.items?.some((i) => i.relPath === 'app/pages/changelog.vue')).toBe(true);

      // 5. stateFlow for Nuxt useState('isBirthday') and variable-to-key resolution ('birthdayAlias' -> 'nuxt-birthday')
      const stateRes = await queryGraph({
        workspaceRoot: workDir,
        query: 'stateFlow',
        target: { symbol: 'isBirthday' },
        skipSync: true,
        ...opts,
      });
      expect(stateRes.data.items?.some((i) => i.kind === 'writes_state' && i.isWriteAccess)).toBe(true);
      expect(stateRes.data.items?.filter((i) => i.kind === 'reads_state').length).toBeGreaterThanOrEqual(2);

      const aliasStateRes = await queryGraph({
        workspaceRoot: workDir,
        query: 'stateFlow',
        target: { symbol: 'birthdayAlias' },
        skipSync: true,
        ...opts,
      });
      expect(aliasStateRes.data.targetSummary).toBe('state:birthdayAlias -> key:nuxt-birthday');
      expect(aliasStateRes.data.items?.some((i) => i.kind === 'writes_state' && i.isWriteAccess)).toBe(true);
      expect(aliasStateRes.data.items?.some((i) => i.kind === 'reads_state')).toBe(true);

      // Empty stateFlow emits diagnostic instead of silent empty
      const emptyState = await queryGraph({
        workspaceRoot: workDir,
        query: 'stateFlow',
        target: { symbol: 'unknownStateKey' },
        skipSync: true,
        ...opts,
      });
      expect(emptyState.data.items).toHaveLength(0);
      expect(emptyState.diagnostics.some((d) => d.code === 'STATE_FLOW_NO_MATCHES')).toBe(true);
    } finally {
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
