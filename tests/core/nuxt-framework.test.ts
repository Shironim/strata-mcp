import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRoutes, scanNuxtNitroRoutes, extractNuxtPageMeta } from '../../src/engine/routes';
import { extractComponentContract } from '../../src/engine/contract';
import { extractDataDependencies, extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { auditEventHandlers } from '../../src/engine/reactivity';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';

describe('02 - Nuxt.js Framework Plan (Nuxt 3 & Nuxt 4)', () => {
  // =========================================================================
  // 1. Nitro Server Routes & API Scanning (N01)
  // =========================================================================
  describe('N01 — Nitro Server Routes Scanner', () => {
    test('extracts HTTP methods and route params from file suffixes and paths', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-nitro-'));
      try {
        await fs.mkdir(join(testDir, 'server', 'api', 'users'), { recursive: true });
        await fs.mkdir(join(testDir, 'server', 'routes'), { recursive: true });

        // server/api/users/[id].patch.ts
        await fs.writeFile(
          join(testDir, 'server', 'api', 'users', '[id].patch.ts'),
          `export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  const body = await readBody(event);
  return { updated: id };
});`,
          'utf8'
        );

        // server/routes/health.get.ts
        await fs.writeFile(
          join(testDir, 'server', 'routes', 'health.get.ts'),
          `export default defineEventHandler(() => 'OK');`,
          'utf8'
        );

        // server/api/feed.ts with assertMethod
        await fs.writeFile(
          join(testDir, 'server', 'api', 'feed.ts'),
          `export default defineEventHandler(async (event) => {
  assertMethod(event, ['POST', 'PUT']);
  return { ok: true };
});`,
          'utf8'
        );

        // server/api/generic.ts (default ALL)
        await fs.writeFile(
          join(testDir, 'server', 'api', 'generic.ts'),
          `export default defineEventHandler((event) => {
  return { status: 'ok' };
});`,
          'utf8'
        );

        const nitroRoutes = await scanNuxtNitroRoutes(testDir);

        const patchRoute = nitroRoutes.find(r => r.path === '/api/users/[id]');
        expect(patchRoute).toBeDefined();
        expect(patchRoute?.type).toBe('api');
        expect(patchRoute?.framework).toBe('nuxt');
        expect(patchRoute?.handlers).toEqual(['PATCH']);
        expect(patchRoute?.params?.map(p => p.name)).toContain('id');

        const healthRoute = nitroRoutes.find(r => r.path === '/health');
        expect(healthRoute).toBeDefined();
        expect(healthRoute?.type).toBe('api');
        expect(healthRoute?.handlers).toEqual(['GET']);

        const feedRoute = nitroRoutes.find(r => r.path === '/api/feed');
        expect(feedRoute).toBeDefined();
        expect(feedRoute?.handlers).toEqual(['POST', 'PUT']);

        const genericRoute = nitroRoutes.find(r => r.path === '/api/generic');
        expect(genericRoute).toBeDefined();
        expect(genericRoute?.handlers).toEqual(['ALL']);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('scanRoutes integrates Nuxt Nitro routes alongside page routes', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-manifest-'));
      try {
        await fs.mkdir(join(testDir, 'pages'), { recursive: true });
        await fs.mkdir(join(testDir, 'server', 'api'), { recursive: true });
        await fs.writeFile(join(testDir, 'nuxt.config.ts'), 'export default defineNuxtConfig({});', 'utf8');

        await fs.writeFile(
          join(testDir, 'pages', 'index.vue'),
          `<template><div>Home</div></template>`,
          'utf8'
        );
        await fs.writeFile(
          join(testDir, 'server', 'api', 'users.get.ts'),
          `export default defineEventHandler(() => []);`,
          'utf8'
        );

        const manifest = await scanRoutes({ targetPath: testDir });
        expect(manifest.framework).toBe('nuxt');

        const home = manifest.routes.find(r => r.path === '/');
        expect(home).toBeDefined();
        expect(home?.type).toBe('page');

        const usersApi = manifest.routes.find(r => r.path === '/api/users');
        expect(usersApi).toBeDefined();
        expect(usersApi?.type).toBe('api');
        expect(usersApi?.handlers).toEqual(['GET']);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 2. definePageMeta Extraction & Page Meta Contracts (N02)
  // =========================================================================
  describe('N02 — definePageMeta & Page Meta Extraction', () => {
    test('extracts layout, middleware, alias, keepalive and custom meta keys', () => {
      const code = `<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'tenant'],
  alias: ['/admin-panel', '/dashboard/admin'],
  keepalive: true,
  pageTransition: false,
  requiredRole: 'superadmin',
  analyticsId: 1042
});
</script>

<template>
  <div class="admin-page">Admin</div>
</template>`;

      const meta = extractNuxtPageMeta(code);
      expect(meta).toBeDefined();
      expect(meta?.layout).toBe('admin');
      expect(meta?.middleware).toEqual(['auth', 'tenant']);
      expect(meta?.alias).toEqual(['/admin-panel', '/dashboard/admin']);
      expect(meta?.keepalive).toBe(true);
      expect(meta?.pageTransition).toBe(false);
      expect(meta?.customMetaKeys).toContain('requiredRole');
      expect(meta?.customMetaKeys).toContain('analyticsId');
    });

    test('extracts definePageMeta with nested arrow functions and internal parentheses correctly', () => {
      const code = `<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  validate: (route) => ({ ok: checkRole(route) }),
  middleware: ['auth', 'tenant'],
  alias: ['/admin-panel']
});
</script>
<template><div>Admin</div></template>`;

      const meta = extractNuxtPageMeta(code);
      expect(meta).toBeDefined();
      expect(meta?.layout).toBe('admin');
      // Must not cut off middleware or alias after the inner ({ ... })
      expect(meta?.middleware).toEqual(['auth', 'tenant']);
      expect(meta?.alias).toEqual(['/admin-panel']);
      expect(meta?.customMetaKeys).toContain('validate');
    });

    test('extractComponentContract surfaces nuxtPageMeta for Nuxt pages', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-contract-'));
      const filePath = join(testDir, 'Dashboard.vue');
      try {
        const code = `<script setup lang="ts">
definePageMeta({
  layout: 'sidebar',
  middleware: ['auth']
});
</script>
<template><div>Dashboard</div></template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const contract = await extractComponentContract(filePath);

        expect(contract.nuxtPageMeta).toBeDefined();
        expect(contract.nuxtPageMeta?.layout).toBe('sidebar');
        expect(contract.nuxtPageMeta?.middleware).toEqual(['auth']);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 3. Nuxt Data & State Dependencies (useFetch, useState)
  // =========================================================================
  describe('N02 — Data & State Dependencies Tracking', () => {
    test('tracks useFetch, useLazyFetch, useAsyncData and useState correctly', () => {
      const code = `<script setup lang="ts">
const { data: users } = await useFetch('/api/users');
const { data: posts } = await useLazyFetch('/api/posts', { query: { active: true } });
const { data: stats } = await useAsyncData('app-stats', () => $fetch('/api/stats'));
const token = useState('auth-token', () => '');
</script>`;

      const dataDeps = extractDataDependencies(code, 'nuxt');
      expect(dataDeps?.endpoints).toContain('/api/users');
      expect(dataDeps?.endpoints).toContain('/api/posts');
      expect(dataDeps?.queryKeys).toContain('"app-stats"');

      const stateDeps = extractStateDependencies(code, 'nuxt');
      expect(stateDeps.stores).toContain('auth-token');
    });
  });

  // =========================================================================
  // 5. Nuxt Auto-Import Event Handler Resolution (N04)
  // =========================================================================
  describe('N04 — Nuxt Auto-Import Candidate Resolution', () => {
    test('treats Nuxt built-in helpers as candidate auto-imports instead of broken handlers', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-auto-'));
      const filePath = join(testDir, 'pages', 'Home.vue');
      try {
        await fs.mkdir(join(testDir, 'pages'), { recursive: true });
        await fs.mkdir(join(testDir, 'composables'), { recursive: true });
        await fs.writeFile(join(testDir, 'composables', 'http.ts'), 'export function useHTTPClient() {}');
        await fs.writeFile(
          join(testDir, 'nuxt.config.ts'),
          'export default defineNuxtConfig({});',
          'utf8'
        );

        const code = `<script setup lang="ts">
definePageMeta({ layout: 'default' });
</script>

<template>
  <div>
    <!-- navigateTo and refreshNuxtData are Nuxt auto-imports -->
    <button @click="navigateTo('/dashboard')">Go</button>
    <button @click="refreshNuxtData('users')">Refresh</button>
    <button @click="useHTTPClient('api')">HTTP</button>

    <!-- bogusHandler is truly broken -->
    <button @click="bogusHandlerNonExistent">Broken</button>
  </div>
</template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const audit = await auditEventHandlers({ path: filePath });

        // Broken handler should only contain bogusHandlerNonExistent
        expect(audit.brokenHandlers.length).toBe(1);
        expect(audit.brokenHandlers[0].handlerName).toBe('bogusHandlerNonExistent');

        // candidateHandlers should have navigateTo, refreshNuxtData and useHTTPClient
        expect(audit.candidateHandlers).toBeDefined();
        const candidateNames = audit.candidateHandlers!.map(c => c.handlerName);
        expect(candidateNames).toContain('navigateTo');
        expect(candidateNames).toContain('refreshNuxtData');
        expect(candidateNames).toContain('useHTTPClient');

        const navCandidate = audit.candidateHandlers!.find(c => c.handlerName === 'navigateTo');
        expect(navCandidate?.source).toBe('nuxt-auto-import');
        expect(navCandidate?.evidence?.resolution).toBe('candidate');
        expect(navCandidate?.evidence?.method).toBe('nuxt-auto-import');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });
});
