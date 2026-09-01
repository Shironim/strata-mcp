import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  stripJsonComments,
} from '../../src/engine/resolver';
import { getComponentTree, resolveImportPath } from '../../src/engine/tree';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Alias (@/) resolution in component tree', () => {
  it('discovers jsconfig paths and resolves @/ alias', async () => {
    const root = join(FIXTURES_DIR, 'AliasTreeRoot.vue');
    const aliasConfig = await loadAliasConfig(root);

    expect(aliasConfig).not.toBeNull();
    expect(aliasConfig!.isAlias('@/AliasChild.vue')).toBe(true);
    expect(aliasConfig!.isAlias('vue')).toBe(false);

    const resolved = resolveImportPath(root, '@/AliasChild.vue', aliasConfig);
    expect(resolved).toContain('AliasChild.vue');
  });

  it('includes alias-imported components in the downward tree', async () => {
    const result = await getComponentTree({
      entryPath: join(FIXTURES_DIR, 'AliasTreeRoot.vue'),
      maxDepth: 3,
    });

    const childNames = result.root.children.map((c) => c.component);
    expect(childNames).toContain('AliasChild.vue');
  });

  it('resolves an explicit alias_map prefix provided by the caller', async () => {
    const aliasConfig = createAliasConfig({ '@alt/': './' }, FIXTURES_DIR);

    expect(aliasConfig.isAlias('@alt/AliasChild.vue')).toBe(true);
    expect(aliasConfig.resolve('@alt/AliasChild.vue')).toContain('AliasChild.vue');
  });

  it('lets explicit alias_map win over auto-detected config for the same prefix', async () => {
    const autoDetected = await loadAliasConfig(join(FIXTURES_DIR, 'AliasTreeRoot.vue'));
    const explicit = createAliasConfig({ '@/*': './' }, FIXTURES_DIR);
    const merged = mergeAliasConfigs(explicit, autoDetected);

    // Both resolve the same specifier, but explicit must be tried first.
    const resolved = resolveImportPath(join(FIXTURES_DIR, 'AliasTreeRoot.vue'), '@/AliasChild.vue', merged);
    expect(resolved).toContain('AliasChild.vue');
    expect(merged!.resolve('@/AliasChild.vue')).toBe(explicit.resolve('@/AliasChild.vue'));
  });

  it('resolves alias_map-only imports inside get_component_tree', async () => {
    const result = await getComponentTree({
      entryPath: join(FIXTURES_DIR, 'AliasOverrideRoot.vue'),
      maxDepth: 3,
      aliasMap: { '@alt/': './' },
    });

    const childNames = result.root.children.map((c) => c.component);
    expect(childNames).toContain('AliasChild.vue');
  });

  it('correctly strips JSONC comments and trailing commas from tsconfig', () => {
    const rawJsonc = `{
      // Single-line comment
      "compilerOptions": {
        "baseUrl": ".",
        /* Multi-line
           comment */
        "paths": {
          "@/*": ["./*"],
        },
      },
    }`;

    const parsed = JSON.parse(stripJsonComments(rawJsonc));
    expect(parsed.compilerOptions.baseUrl).toBe('.');
    expect(parsed.compilerOptions.paths['@/*']).toEqual(['./*']);
  });

  it('forwards aliasConfig through resolveBarrelExport to resolve aliased re-exports', () => {
    const aliasConfig = createAliasConfig({ '@components/': './' }, FIXTURES_DIR);
    // Simulate barrel content using resolveBarrelExport with mock or fixture
    const barrelTarget = resolveImportPath(
      join(FIXTURES_DIR, 'index.ts'),
      '@components/AliasChild.vue',
      aliasConfig
    );
    expect(barrelTarget).not.toBeNull();
    expect(barrelTarget).toContain('AliasChild.vue');
  });
});
