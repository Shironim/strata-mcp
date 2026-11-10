import { describe, expect, it } from 'bun:test';
import { resolveWorkspacePath, resolveProjectRoot } from '../../src/engine/path-resolver';
import {
  scanDynamicImportsAndGlobals,
  type DynamicRegistry,
} from '../../src/engine/dynamic-imports';

describe('Resilience & Boundary Edge Cases (tests/core/resilience.test.ts)', () => {
  describe('Path Resolver Self-Contained Edge Cases', () => {
    it('normalizes Windows backslashes and redundant dots seamlessly', () => {
      const rootHint = '/workspace/project';
      const resolved = resolveWorkspacePath('src\\components\\..\\components\\Button.vue', rootHint);
      expect(resolved.replace(/\\/g, '/')).toContain('workspace/project/src/components/Button.vue');
    });

    it('handles empty path string by resolving project root cleanly', () => {
      const resolved = resolveWorkspacePath('');
      expect(typeof resolved).toBe('string');
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('resolves project root cleanly when target path is not supplied', () => {
      const root = resolveProjectRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('Dynamic Imports Self-Contained Edge Cases', () => {
    it('handles empty or comment-only scripts without throwing exceptions', async () => {
      const registry = await scanDynamicImportsAndGlobals(
        '/workspace/app',
        [{ file: '/workspace/app/src/main.ts', content: '// just comments\n/* block */' }],
        ['/workspace/app/src/main.ts']
      );
      expect(registry.asyncComponents.length).toBe(0);
      expect(registry.globPatterns.length).toBe(0);
    });

    it('scans defineAsyncComponent and resolves matches in registry', async () => {
      const code = `
        const AsyncModal = defineAsyncComponent(() => import('./components/Modal.vue'));
      `;
      const allFiles = [
        '/workspace/app/src/App.vue',
        '/workspace/app/src/components/Modal.vue',
      ];
      const registry = await scanDynamicImportsAndGlobals(
        '/workspace/app',
        [{ file: '/workspace/app/src/App.vue', content: code }],
        allFiles
      );

      expect(registry.asyncComponents.length).toBe(1);
      expect(registry.asyncComponents[0].specifier).toBe('./components/Modal.vue');
      expect(registry.asyncComponents[0].name).toBe('AsyncModal');
    });
  });
});
