import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatStateChainAsText, traceStateChain } from '../../src/engine/database';

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

    const result = await traceStateChain(tempDir, {
      identifier: 'useCartStore',
      direction: 'both',
      maxDepth: 3,
    });

    expect(result.identifier).toBe('useCartStore');

    // Consumers check: CartPage.vue should be in consumers
    const consumerPaths = result.consumers.map((c) => c.filePath.replace(/\\/g, '/'));
    expect(consumerPaths.some((p) => p.includes('CartPage.vue'))).toBe(true);

    // Dependencies check: useNotification should be in dependencies
    const depNames = result.dependencies.map((d) => d.identifier);
    expect(depNames).toContain('useNotification');

    // Formatting check
    const formatted = formatStateChainAsText(result);
    expect(formatted).toContain('State Dependency Chain: `useCartStore`');
    expect(formatted).toContain('CartPage.vue');
    expect(formatted).toContain('useNotification');

    // Clean up with Windows file lock safety
    try {
      const db = getWorkspaceDatabase(tempDir);
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore file lock on Windows
    }
  });
});
