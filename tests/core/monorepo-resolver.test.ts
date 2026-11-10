import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadAliasConfig, discoverMonorepoAliases } from '../../src/engine/resolver';
import { resolveImportPath } from '../../src/engine/graph/path-helpers';

describe('Multi-Root Monorepo Discovery & Alias Resolution', () => {
  it('discovers internal monorepo packages and resolves cross-package imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-monorepo-'));
    try {
      // 1. Create root pnpm-workspace.yaml
      await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");

      // 2. Create packages/ui with package.json
      const uiDir = join(root, 'packages/ui');
      const uiSrcDir = join(uiDir, 'src');
      await mkdir(uiSrcDir, { recursive: true });
      await writeFile(
        join(uiDir, 'package.json'),
        JSON.stringify({
          name: '@myorg/ui',
          version: '1.0.0',
          exports: {
            '.': './src/index.ts',
            './button': './src/button.tsx',
          },
        })
      );
      await writeFile(join(uiSrcDir, 'index.ts'), "export * from './button';");
      await writeFile(join(uiSrcDir, 'button.tsx'), "export const Button = () => 'button';");

      // 3. Create apps/web with an app component
      const appDir = join(root, 'apps/web');
      const appSrcDir = join(appDir, 'src');
      await mkdir(appSrcDir, { recursive: true });
      const pageFile = join(appSrcDir, 'Page.tsx');
      await writeFile(pageFile, "import { Button } from '@myorg/ui';\nimport { Button as Btn } from '@myorg/ui/button';\n");

      // 4. Test discoverMonorepoAliases
      const monorepoConfig = discoverMonorepoAliases(pageFile);
      expect(monorepoConfig).not.toBeNull();
      expect(monorepoConfig?.isAlias('@myorg/ui')).toBe(true);
      expect(monorepoConfig?.isAlias('@myorg/ui/button')).toBe(true);

      const resolvedRoot = monorepoConfig?.resolve('@myorg/ui');
      expect(resolvedRoot).toBe(join(uiSrcDir, 'index.ts'));

      const resolvedSub = monorepoConfig?.resolve('@myorg/ui/button');
      expect(resolvedSub).toBe(join(uiSrcDir, 'button.tsx'));

      // 5. Test loadAliasConfig and resolveImportPath
      const aliasConfig = await loadAliasConfig(pageFile);
      expect(aliasConfig).not.toBeNull();
      expect(aliasConfig?.isAlias('@myorg/ui')).toBe(true);

      const resolvedImport = resolveImportPath(pageFile, '@myorg/ui', aliasConfig);
      expect(resolvedImport).toBe(join(uiSrcDir, 'index.ts'));

      const resolvedSubImport = resolveImportPath(pageFile, '@myorg/ui/button', aliasConfig);
      expect(resolvedSubImport).toBe(join(uiSrcDir, 'button.tsx'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
