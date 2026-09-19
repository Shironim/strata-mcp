import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractStateDependencies } from '../../src/engine/contract';
import {
  getWorkspaceDatabase,
  queryStateImpact,
  syncWorkspace,
} from '../../src/engine/database';

describe('Granular State Tracking & Mutator/Reader Ingestion', () => {
  it('extracts write, watch, and read access modes with line numbers and snippets', () => {
    const vueContent = `
<script setup lang="ts">
import { useCartStore } from '../stores/cart';
import { watch } from 'vue';

const cart = useCartStore();

watch(() => cart.items, () => {
  console.log('items changed');
});

function onCheckout() {
  cart.checkout();
}
</script>
<template>
  <div>{{ cart.total }}</div>
</template>
    `.trim();

    const result = extractStateDependencies(vueContent, 'vue');

    expect(result.stores).toContain('useCartStore');
    expect(result.items).toBeDefined();

    const items = result.items!;
    const cartItems = items.filter((it) => it.identifier === 'useCartStore');
    expect(cartItems.length).toBeGreaterThan(0);

    // Verify mutator (write) is detected
    const writeItem = cartItems.find((it) => it.accessMode === 'write');
    expect(writeItem).toBeDefined();
    expect(writeItem?.usageSnippet).toContain('cart.checkout()');

    // Verify watcher is detected
    const watchItem = cartItems.find((it) => it.accessMode === 'watch');
    expect(watchItem).toBeDefined();

    // Verify reader is detected
    const readItem = cartItems.find((it) => it.accessMode === 'read');
    expect(readItem).toBeDefined();
  });

  it('classifies mutators and readers in SQLite SSOT without disk re-reads during queryStateImpact', async () => {
    const tempDir = join(tmpdir(), `strata-granular-state-${Date.now()}`);
    await fs.mkdir(join(tempDir, 'stores'), { recursive: true });
    await fs.mkdir(join(tempDir, 'components'), { recursive: true });

    // 1. Store file
    await fs.writeFile(
      join(tempDir, 'stores', 'cart.ts'),
      `
      export function useCartStore() {
        return { items: [], checkout: () => {} };
      }
      `,
      'utf8'
    );

    // 2. Mutator component
    await fs.writeFile(
      join(tempDir, 'components', 'CheckoutButton.vue'),
      `
      <template>
        <button @click="handleCheckout">Pay</button>
      </template>
      <script setup lang="ts">
      import { useCartStore } from '../stores/cart';
      const cart = useCartStore();
      function handleCheckout() {
        cart.checkout();
      }
      </script>
      `,
      'utf8'
    );

    // 3. Reader component
    await fs.writeFile(
      join(tempDir, 'components', 'CartBadge.vue'),
      `
      <template>
        <span>{{ cart.items.length }}</span>
      </template>
      <script setup lang="ts">
      import { useCartStore } from '../stores/cart';
      const cart = useCartStore();
      </script>
      `,
      'utf8'
    );

    // Sync into SQLite SSOT
    await syncWorkspace(tempDir);
    const db = getWorkspaceDatabase(tempDir);

    // Verify SQLite table schema and ingested rows
    const rows = db
      .query(
        `
      SELECT f.path, s.access_mode, s.line_number, s.usage_snippet
      FROM state_deps s
      JOIN files f ON s.file_id = f.id
      WHERE s.identifier = 'useCartStore'
      ORDER BY s.access_mode ASC;
    `
      )
      .all() as Array<{
      path: string;
      access_mode: string;
      line_number: number;
      usage_snippet: string;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    const hasWriteRow = rows.some((r) => r.access_mode === 'write');
    expect(hasWriteRow).toBe(true);

    // Test queryStateImpact
    const allImpact = await queryStateImpact(tempDir, 'useCartStore', 'all');
    expect(allImpact.totalConsumers).toBe(2);
    expect(allImpact.mutatorsCount).toBe(1);
    expect(allImpact.readersCount).toBe(1);

    const mutatorPaths = allImpact.mutators?.map((m) => m.path.replace(/\\/g, '/')) || [];
    const readerPaths = allImpact.readers?.map((r) => r.path.replace(/\\/g, '/')) || [];

    expect(mutatorPaths.some((p) => p.includes('CheckoutButton.vue'))).toBe(true);
    expect(readerPaths.some((p) => p.includes('CartBadge.vue'))).toBe(true);

    // Filter by role
    const mutatorsOnly = await queryStateImpact(tempDir, 'useCartStore', 'mutators');
    expect(mutatorsOnly.consumers.length).toBe(1);
    expect(mutatorsOnly.consumers[0].path.replace(/\\/g, '/')).toContain('CheckoutButton.vue');

    const readersOnly = await queryStateImpact(tempDir, 'useCartStore', 'readers');
    expect(readersOnly.consumers.length).toBe(1);
    expect(readersOnly.consumers[0].path.replace(/\\/g, '/')).toContain('CartBadge.vue');

    // Clean up
    try {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore file lock cleanup errors
    }
  });
});
