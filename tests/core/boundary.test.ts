import { describe, expect, it } from 'bun:test';
import {
  extractRenderBoundary,
  extractStateDependencies,
  formatContractAsText,
} from '../../src/engine/contract';
import type { ComponentContract } from '../../src/types';

describe('Render Boundary & State Dependencies Extractor (Phase 3)', () => {
  describe('extractRenderBoundary', () => {
    it("detects 'use client' directive in React component", () => {
      const code = `'use client';\nimport React from 'react';\nexport function Modal() { return <div />; }`;
      const result = extractRenderBoundary('src/components/Modal.tsx', code, 'react');
      expect(result.boundary).toBe('client-component');
      expect(result.directive).toBe('use client');
      expect(result.isClientHydrated).toBe(true);
    });

    it("detects 'use server' directive for server actions", () => {
      const code = `'use server';\nexport async function createUser(data: any) {}`;
      const result = extractRenderBoundary('app/actions/user.ts', code, 'react');
      expect(result.boundary).toBe('server-action');
      expect(result.directive).toBe('use server');
      expect(result.isClientHydrated).toBe(false);
    });

    it('defaults to React Server Component (RSC) inside app/ directory', () => {
      const code = `export default function Page() { return <h1>Hello</h1>; }`;
      const result = extractRenderBoundary('app/dashboard/page.tsx', code, 'react');
      expect(result.boundary).toBe('server-component');
      expect(result.isClientHydrated).toBe(false);
    });

    it('detects Nuxt .client.vue and .server.vue suffixes', () => {
      const clientResult = extractRenderBoundary('components/Chart.client.vue', '<template />', 'vue');
      expect(clientResult.boundary).toBe('client-only');
      expect(clientResult.isClientHydrated).toBe(true);

      const serverResult = extractRenderBoundary('components/Stats.server.vue', '<template />', 'vue');
      expect(serverResult.boundary).toBe('server-only');
      expect(serverResult.isClientHydrated).toBe(false);
    });

    it('detects Astro client hydration directives on islands', () => {
      const code = `---
import Counter from './Counter.vue';
---
<Counter client:visible />
`;
      const islandResult = extractRenderBoundary('src/pages/index.astro', code, 'astro');
      expect(islandResult.boundary).toBe('astro-island');
      expect(islandResult.directive).toContain('client:visible');
      expect(islandResult.isClientHydrated).toBe(true);

      const staticResult = extractRenderBoundary('src/pages/static.astro', '<h1>Static</h1>', 'astro');
      expect(staticResult.boundary).toBe('astro-static');
      expect(staticResult.isClientHydrated).toBe(false);
    });
  });

  describe('extractStateDependencies', () => {
    it('extracts Pinia store, inject, and composables from Vue component', () => {
      const code = `
<script setup lang="ts">
import { inject } from 'vue';
const cartStore = useCartStore();
const auth = useAuthStore();
const dialog = inject('modalService');
const router = useRouter();
const notification = useNotification();
</script>
`;
      const result = extractStateDependencies(code, 'vue');
      expect(result.stores).toContain('useCartStore');
      expect(result.stores).toContain('useAuthStore');
      expect(result.contexts).toContain('modalService');
      expect(result.composables).toContain('useRouter');
      expect(result.composables).toContain('useNotification');
    });

    it('extracts Redux selectors and React useContext', () => {
      const code = `
import { useContext } from 'react';
import { useSelector, useDispatch } from 'react-redux';

export function Cart() {
  const theme = useContext(ThemeContext);
  const items = useSelector(selectCartItems);
  const dispatch = useDispatch();
  const query = useQuery(['items']);
}
`;
      const result = extractStateDependencies(code, 'react');
      expect(result.stores).toContain('useSelector');
      expect(result.stores).toContain('useDispatch');
      expect(result.contexts).toContain('ThemeContext');
      expect(result.composables).toContain('useQuery');
    });
  });

  describe('formatContractAsText with Render Boundary and State Dependencies', () => {
    it('formats contract text including boundaries and state', () => {
      const contract: ComponentContract = {
        component: 'UserProfile',
        framework: 'vue',
        filePath: 'src/components/UserProfile.vue',
        props: [{ name: 'id', type: 'string', required: true }],
        emits: [],
        slots: ['avatar'],
        renderBoundary: {
          boundary: 'client-component',
          directive: 'use client',
          isClientHydrated: true,
        },
        stateDependencies: {
          stores: ['useUserStore'],
          contexts: ['authContext'],
          composables: ['useRouter'],
        },
      };

      const formatted = formatContractAsText(contract);
      expect(formatted).toContain("Render Boundary: client-component ('use client')");
      expect(formatted).toContain('State Dependencies:');
      expect(formatted).toContain('Stores: useUserStore');
      expect(formatted).toContain('Context/Injected: authContext');
      expect(formatted).toContain('Composables: useRouter');
    });
  });
});
