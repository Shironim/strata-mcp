import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRoutes, scanNuxtNitroRoutes, extractNuxtPageMeta } from '../../src/engine/routes';
import { extractComponentContract } from '../../src/engine/contract';
import { extractDataDependencies, extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { runCanonAudit } from '../../src/engine/canon';
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
  // 4. Nuxt Canonical Pattern Rules (N03)
  // =========================================================================
  describe('N03 — Nuxt Canonical Rules', () => {
    test('nuxt/no-raw-fetch-in-setup: flags bare await $fetch in setup, ignores client event helper', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-fetch-'));
      const filePath = join(testDir, 'Posts.vue');
      try {
        const badCode = `<script setup lang="ts">
// Anti-pattern: bare await $fetch at top-level
const posts = await $fetch('/api/posts');

async function onRefresh() {
  // Allowed: $fetch inside client event handler
  await $fetch('/api/posts/refresh');
}
</script>
<template><div>{{ posts }}</div></template>`;

        await fs.writeFile(filePath, badCode, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const d = diags.find(x => x.ruleId === 'nuxt/no-raw-fetch-in-setup');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.category).toBe('ssr-hydration');
        expect(d?.smell.title).toContain("Bare 'await $fetch()' in <script setup> Causes Double-Fetch");

        const sliced = await readSourceRef(filePath, d!.fact.ref);
        expect(sliced).toContain("await $fetch('/api/posts')");
        expect(sliced).not.toContain('/api/posts/refresh');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('nuxt/ssr-browser-api-leak: flags unguarded window and localStorage, ignores guarded ones and event arrow functions', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-browser-'));
      const filePath = join(testDir, 'BrowserLeak.vue');
      try {
        const code = `<script setup lang="ts">
import { onMounted, computed } from 'vue';

// Anti-pattern 1: unguarded browser access in SSR setup
const width = window.innerWidth;
const token = localStorage.getItem('token');

// Anti-pattern 2: browser access inside computed() runs during SSR
const derivedWidth = computed(() => window.innerWidth);

// Canonical / Safe access:
onMounted(() => {
  window.addEventListener('resize', () => {});
});

if (import.meta.client) {
  const localVal = localStorage.getItem('local');
}

// Client event handler function declaration (safe)
function onClick() {
  window.alert('hello');
}

// Client event handler arrow function (safe)
const onScroll = () => {
  console.log(window.scrollY);
};
</script>
<template><div>{{ width }}</div></template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const leaks = diags.filter(x => x.ruleId === 'nuxt/ssr-browser-api-leak');
        // width, token, derivedWidth -> 3 leaks (onClick and onScroll are safe)
        expect(leaks.length).toBe(3);

        const titles = leaks.map(l => l.smell.title);
        expect(titles.filter(t => t.includes("'window'")).length).toBe(2);
        expect(titles.some(t => t.includes("'localStorage'"))).toBe(true);

        // Verify exact slicing
        const slice0 = await readSourceRef(filePath, leaks[0].fact.ref);
        expect(slice0).toMatch(/window\.innerWidth|localStorage\.getItem/);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('nuxt/no-singleton-ref-outside-setup: flags global module ref outside functions in composables', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-singleton-'));
      const filePath = join(testDir, 'useAuth.ts');
      try {
        const code = `import { ref } from 'vue';

// Anti-pattern: shared state across concurrent SSR requests!
export const sharedUser = ref<any>(null);

// Canonical: scoped state inside function via useState or local ref
export function useUser() {
  const localRef = ref(null);
  const stateUser = useState('user', () => null);
  return { localRef, stateUser };
}`;

        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const d = diags.find(x => x.ruleId === 'nuxt/no-singleton-ref-outside-setup');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.smell.title).toContain("Global Module 'ref()' Outside Function Causes Cross-Request Pollution");

        const sliced = await readSourceRef(filePath, d!.fact.ref);
        expect(sliced).toContain('sharedUser = ref<any>(null)');
        expect(sliced).not.toContain('localRef');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('nuxt/await-after-reactive-context: flags Nuxt composables invoked after await in setup, ignores client handlers', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-await-'));
      const filePath = join(testDir, 'AsyncOrder.vue');
      try {
        const code = `<script setup lang="ts">
// Safe: invoked before await
const config = useRuntimeConfig();

await doSomethingAsync();

// Anti-pattern: invoked at top-level after await, losing Nuxt context instance
const route = useRoute();

// Safe: invoked inside an event handler after await
function onUserClick() {
  const innerRoute = useRoute();
}

const onArrowClick = () => {
  const arrowRoute = useRoute();
};
</script>
<template><div>{{ route.path }}</div></template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const awaitSmells = diags.filter(x => x.ruleId === 'nuxt/await-after-reactive-context');
        // Only top-level useRoute() after await is flagged!
        expect(awaitSmells.length).toBe(1);
        expect(awaitSmells[0].smell.title).toContain("Nuxt Composable 'useRoute()' Called After 'await'");

        const sliced = await readSourceRef(filePath, awaitSmells[0].fact.ref);
        expect(sliced).toBe('useRoute()');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('nuxt/prefer-navigate-to: flags window.location, location.href, and location.replace', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-nav-'));
      const filePath = join(testDir, 'Redirect.vue');
      try {
        const code = `<script setup lang="ts">
function onLogout() {
  window.location.href = '/login';
}

function onAssign() {
  window.location = '/login';
}

function onReplace() {
  location.replace('/login');
}
</script>
<template><button @click="onLogout">Logout</button></template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const navSmells = diags.filter(x => x.ruleId === 'nuxt/prefer-navigate-to');
        expect(navSmells.length).toBe(3);
        expect(navSmells[0].severity).toBe('warning');
        expect(navSmells[0].canon.summary).toContain("Use Nuxt canonical 'return navigateTo(...)'");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('nuxt/use-fetch-reactive-watch: flags static evaluation in both template strings and binary concatenation', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-watch-'));
      const filePath = join(testDir, 'Search.vue');
      try {
        const code = `<script setup lang="ts">
import { ref } from 'vue';

const page = ref(1);

// Anti-pattern 1: template string evaluated only once during setup
const { data: staticList } = await useFetch(\`/api/items?page=\${page.value}\`);

// Anti-pattern 2: binary string concatenation evaluated only once
const { data: concatList } = await useFetch('/api/items?page=' + page.value);

// Canonical: getter function or query param
const { data: dynamicList } = await useFetch(() => \`/api/items?page=\${page.value}\`);
const { data: queryList } = await useFetch('/api/items', { query: { page } });
</script>
<template><div>Search</div></template>`;

        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'nuxt');

        const watchSmells = diags.filter(x => x.ruleId === 'nuxt/use-fetch-reactive-watch');
        expect(watchSmells.length).toBe(2);
        expect(watchSmells[0].smell.title).toContain("Static Evaluation of '.value' in useFetch() Argument");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
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
