import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  stripJsonComments,
} from '../../src/engine/resolver';
import { getComponentTree, resolveImportPath } from '../../src/engine/tree';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import ts from 'typescript';
import { STRATA_VERSION } from '../../src/version';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Alias (@/) resolution in component tree', () => {
  it('matches TypeScript path priority and JavaScript extension substitution in the graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-alias-priority-'));
    try {
      for (const dir of ['src', 'src/special', 'specific', 'fallback']) mkdirSync(join(root, dir));
      const paths = { '@/*': ['src/*', 'fallback/*'], '@/special/*': ['specific/*'] };
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths } }));
      const parent = join(root, 'Parent.tsx');
      writeFileSync(parent, "import Item from '@/special/item'; import Other from '@/other.js'; import Widget from '@/widget.jsx'; export default () => <><Item/><Other/><Widget/></>");
      for (const file of ['src/special/item.tsx', 'specific/item.tsx', 'src/other.ts', 'fallback/other.js', 'src/widget.tsx', 'fallback/widget.jsx']) {
        writeFileSync(join(root, file), 'export default () => null');
      }
      const config = await loadAliasConfig(parent);
      const options = { baseUrl: root, paths, moduleResolution: ts.ModuleResolutionKind.Node10 };
      const imports = ['@/special/item', '@/other.js', '@/widget.jsx'];
      const expected = imports.map(specifier => ts.resolveModuleName(specifier, parent, options, ts.sys).resolvedModule!.resolvedFileName);
      expect(expected).toEqual([join(root, 'specific/item.tsx'), join(root, 'src/other.ts'), join(root, 'src/widget.tsx')]);
      expect(imports.map(specifier => resolveImportPath(parent, specifier, config))).toEqual(expected);

      const tree = await getComponentTree({ entryPath: parent, targetPath: root });
      expect(tree.root.children.map(child => child.filePath).sort()).toEqual([...expected].sort());

      const db = getWorkspaceDatabase(root, { create: true });
      await syncWorkspace(root);
      const children = db.query('SELECT c.path FROM edges e JOIN files p ON p.id = e.parent_file_id JOIN files c ON c.id = e.child_file_id WHERE p.path = ?').all(parent) as Array<{ path: string }>;
      expect(children.map(row => row.path).sort()).toEqual([...expected].sort());
      const configPath = join(root, 'tsconfig.json');
      const configContent = JSON.stringify({ compilerOptions: { paths } });
      const oldFingerprint = createHash('sha256').update(`memory-v5:${STRATA_VERSION}`)
        .update(configPath).update('\0').update(createHash('sha256').update(configContent).digest('hex')).digest('hex');
      db.run("UPDATE meta SET value = ? WHERE key = 'config_fingerprint'", [oldFingerprint]);
      db.run('DELETE FROM edges');
      await syncWorkspace(root);
      const rebuilt = db.query('SELECT c.path FROM edges e JOIN files p ON p.id = e.parent_file_id JOIN files c ON c.id = e.child_file_id WHERE p.path = ?').all(parent) as Array<{ path: string }>;
      expect(rebuilt.map(row => row.path).sort()).toEqual([...expected].sort());
      expect((await syncWorkspace(root)).cacheHit).toBe(true);
      rmSync(join(root, 'src/widget.tsx'));
      expect(resolveImportPath(parent, '@/widget.jsx', config)).toBe(join(root, 'fallback/widget.jsx'));
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["import Widget from 'external-library'", "import Widget from './Missing.vue'"])(
    'does not guess an auto import for an explicit binding: %s', async binding => {
      const root = mkdtempSync(join(tmpdir(), 'strata-binding-'));
      try {
        writeFileSync(join(root, 'package.json'), '{}');
        writeFileSync(join(root, 'Widget.vue'), '<template/>');
        writeFileSync(join(root, 'Other.vue'), '<template/>');
        const parent = join(root, 'App.vue');
        writeFileSync(parent, `<script setup>${binding}</script><template><Widget/><Other/></template>`);
        const tree = await getComponentTree({ entryPath: parent, targetPath: root });
        expect(tree.root.children.map(child => child.filePath)).toEqual([join(root, 'Other.vue')]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('tries tsconfig targets in order and indexes the first existing import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-alias-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'fallback'));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*', 'fallback/*'] } } }));
      const parent = join(root, 'Parent.vue');
      const fallback = join(root, 'fallback', 'Child.vue');
      const first = join(root, 'src', 'Child.vue');
      writeFileSync(parent, '<script setup>import Child from "@/Child"</script><template><Child /></template>');
      writeFileSync(fallback, '<template>fallback</template>');
      const config = await loadAliasConfig(parent);
      expect(resolveImportPath(parent, '@/Child', config)).toBe(fallback);
      const db = getWorkspaceDatabase(root, { create: true });
      await syncWorkspace(root);
      const children = () => (db.query('SELECT files.path FROM edges JOIN files ON files.id = edges.child_file_id').all() as Array<{path: string}>).map(row => row.path);
      expect(children()).toContain(fallback);
      writeFileSync(first, '<template>first</template>');
      expect(resolveImportPath(parent, '@/Child', config)).toBe(first);
      await syncWorkspace(root);
      expect(children()).toContain(first);
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
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
