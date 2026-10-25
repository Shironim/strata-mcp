import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeWorkspaceDatabase, getWorkspaceDatabase, formatStateChainAsText, traceStateChain } from '../../src/engine/database';

describe('State Dependency Chain Tracing Engine', () => {
  it('traces multi-hop composable consumers and dependencies', async () => {
    const tempDir = join(tmpdir(), `strata-chain-test-${Date.now()}`);
    await fs.mkdir(join(tempDir, 'composables'), { recursive: true });
    await fs.mkdir(join(tempDir, 'pages'), { recursive: true });

    // 1. Leaf dependency: useNotification
    await fs.writeFile(
      join(tempDir, 'composables', 'useNotification.ts'),
      'export function useNotification() { return { notify: () => {} }; }',
      'utf8'
    );

    // 2. Middle composable: useCartStore (imports and uses useNotification)
    await fs.writeFile(
      join(tempDir, 'composables', 'useCartStore.ts'),
      `
      import { useNotification } from './useNotification';
      export function useCartStore() {
        const { notify } = useNotification();
        return { items: [], notify };
      }
      `,
      'utf8'
    );

    // 3. Top-level page: CartPage.vue (imports and uses useCartStore)
    await fs.writeFile(
      join(tempDir, 'pages', 'CartPage.vue'),
      `
      <template>
        <div>Cart Page</div>
      </template>
      <script setup lang="ts">
      import { useCartStore } from '../composables/useCartStore';
      const cart = useCartStore();
      </script>
      `,
      'utf8'
    );

    getWorkspaceDatabase(tempDir, { create: true });
    const result = await traceStateChain(tempDir, {
      identifier: 'useCartStore',
      direction: 'both',
      maxDepth: 3,
    });

    expect(result.identifier).toBe('useCartStore');
    expect(result._meta?.cached).toBe(false);
    expect(result._meta?.syncGeneration).toBe(1);
    expect(result._meta?.configFingerprint).toMatch(/^[a-f\d]{64}$/);

    // Consumers check: CartPage.vue should be in consumers
    const consumerPaths = result.consumers.map((c) => c.filePath.replace(/\\/g, '/'));
    expect(consumerPaths.some((p) => p.includes('CartPage.vue'))).toBe(true);

    // Dependencies check: useNotification should be in dependencies
    const depNames = result.dependencies.map((d) => d.identifier);
    expect(depNames).toContain('useNotification');

    const warmResult = await traceStateChain(tempDir, { identifier: 'useCartStore' });
    expect(warmResult._meta?.cached).toBe(true);
    expect(warmResult._meta?.syncGeneration).toBe(2);

    await fs.writeFile(join(tempDir, 'composables', 'useExtra.ts'), 'export function useExtra() { return {}; }', 'utf8');
    const changedResult = await traceStateChain(tempDir, { identifier: 'useCartStore' });
    expect(changedResult._meta?.cached).toBe(false);
    expect(changedResult._meta?.syncGeneration).toBe(3);

    // Formatting check
    const formatted = formatStateChainAsText(result);
    expect(formatted).toContain('State Dependency Chain: `useCartStore`');
    expect(formatted).toContain('Graph generation 1 | refreshed');
    expect(formatted).toContain('CartPage.vue');
    expect(formatted).toContain('useNotification');

    // Clean up with Windows file lock safety
    try {
      closeWorkspaceDatabase(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore file lock on Windows
    }
  });
});
