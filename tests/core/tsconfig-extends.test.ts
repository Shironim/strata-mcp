import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadAliasConfig,
  loadAliasConfigWithDependencies,
  loadTsConfigHierarchy,
} from '../../src/engine/resolver';
import { getComponentTree, resolveImportPath } from '../../src/engine/tree';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';

describe('TsConfig Hierarchy & Extends Resolution (F-01 / Invariant I-04)', () => {
  it('resolves aliases through a single relative extends chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-extends-basic-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        extends: './tsconfig.base.json',
      }));

      const childFile = join(root, 'src', 'Child.vue');
      writeFileSync(childFile, '<template>child</template>');
      const parentFile = join(root, 'Parent.vue');
      writeFileSync(parentFile, '<script setup>import Child from "@/Child.vue"</script><template><Child/></template>');

      const config = await loadAliasConfig(parentFile);
      expect(config).not.toBeNull();
      expect(config!.isAlias('@/Child.vue')).toBe(true);
      expect(resolveImportPath(parentFile, '@/Child.vue', config)).toBe(childFile);

      const tree = await getComponentTree({ entryPath: parentFile, targetPath: root });
      expect(tree.root.children.map(c => c.filePath)).toContain(childFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves multi-level extends chains with baseDir isolation and overriding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-extends-multilevel-'));
    try {
      mkdirSync(join(root, 'packages', 'common'), { recursive: true });
      mkdirSync(join(root, 'app', 'src'), { recursive: true });

      // Base in root
      writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@common/*': ['packages/common/*'],
            '@shared/*': ['packages/common/shared/*'],
          },
        },
      }));

      // Intermediate config in app
      writeFileSync(join(root, 'app', 'tsconfig.app.json'), JSON.stringify({
        extends: '../tsconfig.base.json',
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
            // Override @shared/* to app local
            '@shared/*': ['src/shared/*'],
          },
        },
      }));

      // Root tsconfig in app referencing app.json
      writeFileSync(join(root, 'app', 'tsconfig.json'), JSON.stringify({
        extends: './tsconfig.app.json',
      }));

      const commonFile = join(root, 'packages', 'common', 'Header.vue');
      writeFileSync(commonFile, '<template>common header</template>');

      const localShared = join(root, 'app', 'src', 'shared', 'Button.vue');
      mkdirSync(join(root, 'app', 'src', 'shared'), { recursive: true });
      writeFileSync(localShared, '<template>app button</template>');

      const appChild = join(root, 'app', 'src', 'AppChild.vue');
      writeFileSync(appChild, '<template>app child</template>');

      const parentFile = join(root, 'app', 'Parent.vue');
      writeFileSync(parentFile, `
<script setup>
import Header from '@common/Header.vue';
import Button from '@shared/Button.vue';
import AppChild from '@/AppChild.vue';
</script>
<template><Header/><Button/><AppChild/></template>
      `);

      const config = await loadAliasConfig(parentFile);
      expect(config).not.toBeNull();

      // Inherited non-overridden alias from root base
      expect(resolveImportPath(parentFile, '@common/Header.vue', config)).toBe(commonFile);
      // Overridden alias in app
      expect(resolveImportPath(parentFile, '@shared/Button.vue', config)).toBe(localShared);
      // Direct alias in app
      expect(resolveImportPath(parentFile, '@/AppChild.vue', config)).toBe(appChild);

      const tree = await getComponentTree({ entryPath: parentFile, targetPath: join(root, 'app') });
      const childPaths = tree.root.children.map(c => c.filePath);
      expect(childPaths).toContain(commonFile);
      expect(childPaths).toContain(localShared);
      expect(childPaths).toContain(appChild);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports array extends (TypeScript 5.0+)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-extends-array-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'common'));

      writeFileSync(join(root, 'tsconfig.first.json'), JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@common/*': ['common/*'] } },
      }));
      writeFileSync(join(root, 'tsconfig.second.json'), JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        extends: ['./tsconfig.first.json', './tsconfig.second.json'],
      }));

      const f1 = join(root, 'common', 'Header.vue');
      const f2 = join(root, 'src', 'Child.vue');
      writeFileSync(f1, '<template>header</template>');
      writeFileSync(f2, '<template>child</template>');

      const parent = join(root, 'Parent.vue');
      writeFileSync(parent, '<script setup>import Header from "@common/Header.vue"; import Child from "@/Child.vue"</script><template><Header/><Child/></template>');

      const config = await loadAliasConfig(parent);
      expect(resolveImportPath(parent, '@common/Header.vue', config)).toBe(f1);
      expect(resolveImportPath(parent, '@/Child.vue', config)).toBe(f2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('safely breaks circular extends chains without infinite recursion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-extends-circular-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'tsconfig.a.json'), JSON.stringify({
        extends: './tsconfig.b.json',
        compilerOptions: { baseUrl: '.', paths: { '@a/*': ['src/a/*'] } },
      }));
      writeFileSync(join(root, 'tsconfig.b.json'), JSON.stringify({
        extends: './tsconfig.a.json',
        compilerOptions: { baseUrl: '.', paths: { '@b/*': ['src/b/*'] } },
      }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        extends: './tsconfig.a.json',
      }));

      const hierarchy = await loadTsConfigHierarchy(join(root, 'tsconfig.json'));
      expect(hierarchy.paths).toHaveProperty('@a/*');
      expect(hierarchy.paths).toHaveProperty('@b/*');
      expect(hierarchy.configFiles.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates workspace cache when an extended base config file is mutated (Invariant I-04)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-extends-invalidation-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'v1'));
      mkdirSync(join(root, 'v2'));

      const childV1 = join(root, 'v1', 'Child.vue');
      const childV2 = join(root, 'v2', 'Child.vue');
      writeFileSync(childV1, '<template>child v1</template>');
      writeFileSync(childV2, '<template>child v2</template>');

      writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['v1/*'] },
        },
      }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        extends: './tsconfig.base.json',
      }));

      const parent = join(root, 'Parent.vue');
      writeFileSync(parent, '<script setup>import Child from "@/Child.vue"</script><template><Child/></template>');

      // Initialize database
      getWorkspaceDatabase(root, { create: true });

      // Initial cold sync
      const firstSync = await syncWorkspace(root);
      expect(firstSync.cacheHit).toBe(false);

      const db = getWorkspaceDatabase(root);
      const getRenderedChild = () => {
        const row = db.query(`
          SELECT c.path FROM edges e
          JOIN files p ON p.id = e.parent_file_id
          JOIN files c ON c.id = e.child_file_id
          WHERE p.path = ?
        `).get(parent) as { path: string } | null;
        return row?.path;
      };

      expect(getRenderedChild()).toBe(childV1);

      // Warm sync without changes -> cacheHit: true
      const secondSync = await syncWorkspace(root);
      expect(secondSync.cacheHit).toBe(true);
      expect(secondSync.parserInvocations).toBe(0);

      // Mutate the extended base config to point @/* to v2/*
      writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['v2/*'] },
        },
      }));

      // Third sync: MUST detect the config change, invalidate cache, and re-resolve
      const thirdSync = await syncWorkspace(root);
      expect(thirdSync.cacheHit).toBe(false);
      expect(thirdSync.parserInvocations).toBeGreaterThan(0);
      expect(getRenderedChild()).toBe(childV2);
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tracks external parent config in extends chain across monorepo boundaries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'strata-monorepo-extends-'));
    try {
      const parentDir = join(tempDir, 'repo');
      const appDir = join(parentDir, 'packages', 'app');
      mkdirSync(appDir, { recursive: true });
      mkdirSync(join(appDir, 'v1'));
      mkdirSync(join(appDir, 'v2'));

      const childV1 = join(appDir, 'v1', 'Child.vue');
      const childV2 = join(appDir, 'v2', 'Child.vue');
      writeFileSync(childV1, '<template>v1</template>');
      writeFileSync(childV2, '<template>v2</template>');

      // Parent tsconfig outside the app workspace root
      const parentTsConfig = join(parentDir, 'tsconfig.parent.json');
      writeFileSync(parentTsConfig, JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['packages/app/v1/*'] },
        },
      }));

      // App tsconfig extending parent
      writeFileSync(join(appDir, 'tsconfig.json'), JSON.stringify({
        extends: '../../tsconfig.parent.json',
      }));

      const parentComponent = join(appDir, 'Parent.vue');
      writeFileSync(parentComponent, '<script setup>import Child from "@/Child.vue"</script><template><Child/></template>');

      // Initialize database
      getWorkspaceDatabase(appDir, { create: true });

      // Sync app workspace
      const sync1 = await syncWorkspace(appDir);
      expect(sync1.cacheHit).toBe(false);

      const db = getWorkspaceDatabase(appDir);
      const getChild = () => {
        const row = db.query(`
          SELECT c.path FROM edges e
          JOIN files p ON p.id = e.parent_file_id
          JOIN files c ON c.id = e.child_file_id
          WHERE p.path = ?
        `).get(parentComponent) as { path: string } | null;
        return row?.path;
      };

      expect(getChild()).toBe(childV1);

      // Warm sync
      const sync2 = await syncWorkspace(appDir);
      expect(sync2.cacheHit).toBe(true);

      // Mutate the external parent config outside the workspace
      writeFileSync(parentTsConfig, JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['packages/app/v2/*'] },
        },
      }));

      // Sync again: MUST detect external tsconfig mutation and rebuild!
      const sync3 = await syncWorkspace(appDir);
      expect(sync3.cacheHit).toBe(false);
      expect(getChild()).toBe(childV2);
    } finally {
      closeWorkspaceDatabase(join(tempDir, 'repo', 'packages', 'app'));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
