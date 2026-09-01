import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { getComponentTree, formatTreeAsText } from '../../src/engine/tree';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Tree Engine Upward Blast Radius & Auto-Import (Phase 2)', () => {
  it('resolves auto-imported components in downward tree when not imported in script', async () => {
    const pagePath = join(FIXTURES_DIR, 'AutoImportPage.vue');
    const result = await getComponentTree({
      entryPath: pagePath,
      direction: 'downward',
    });

    expect(result.direction).toBe('downward');
    expect(result.root.component).toBe('AutoImportPage.vue');
    expect(result.root.children.length).toBeGreaterThanOrEqual(1);

    const autoChild = result.root.children.find((c) => c.component === 'AutoImportChild.vue');
    expect(autoChild).toBeDefined();
    expect(autoChild?.isAutoImported).toBe(true);

    const formatted = formatTreeAsText(result);
    expect(formatted).toContain('AutoImportPage.vue (Root Page)');
    expect(formatted).toContain('AutoImportChild.vue [auto-imported]');
  });

  it('resolves upward blast radius tree starting from a leaf component (OldButton.vue)', async () => {
    const leafPath = join(FIXTURES_DIR, 'OldButton.vue');
    const result = await getComponentTree({
      entryPath: leafPath,
      direction: 'upward',
      maxDepth: 3,
    });

    expect(result.direction).toBe('upward');
    expect(result.root.component).toBe('OldButton.vue');
    expect(result.root.children.length).toBeGreaterThanOrEqual(1);

    const consumerNames = result.root.children.map((c) => c.component);
    expect(consumerNames).toContain('PageOne.vue');

    const formatted = formatTreeAsText(result);
    expect(formatted).toContain('OldButton.vue (Target Component - Upward Blast Radius)');
    expect(formatted).toContain('PageOne.vue');
    expect(formatted).toContain('consumers explored');
  });

  it('resolves upward tree for auto-imported child component', async () => {
    const childPath = join(FIXTURES_DIR, 'AutoImportChild.vue');
    const result = await getComponentTree({
      entryPath: childPath,
      direction: 'upward',
    });

    expect(result.direction).toBe('upward');
    expect(result.root.component).toBe('AutoImportChild.vue');

    const consumerNames = result.root.children.map((c) => c.component);
    expect(consumerNames).toContain('AutoImportPage.vue');
  });
});
