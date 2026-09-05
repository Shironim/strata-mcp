import { describe, expect, it } from 'bun:test';
import { resolveWorkspacePath, resolveProjectRoot } from '../../src/engine/path-resolver';
import {
  scanDynamicImportsAndGlobals,
  type DynamicRegistry,
} from '../../src/engine/dynamic-imports';
import {
  findSimilarTemplates,
  formatSimilarTemplatesAsText,
} from '../../src/engine/template-similarity';
import { auditBundleHealth, formatBundleAuditAsText } from '../../src/engine/bundle-audit';
import { auditDesignTokens, formatDesignAuditAsText } from '../../src/engine/style-audit';

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

  describe('Template Similarity Self-Contained Boundaries', () => {
    it('formats clean message when no clusters are detected', () => {
      const emptyResult = {
        workspaceRoot: '/mock/app',
        clusters: [],
        totalComponentsAudited: 5,
      };
      const text = formatSimilarTemplatesAsText(emptyResult);
      expect(text).toContain('Template Similarity & Abstraction Opportunities');
      expect(text).toContain('No duplicate template patterns found');
    });

    it('formats cluster details with similarity percentage and recommendations', () => {
      const clusterResult = {
        workspaceRoot: '/mock/app',
        clusters: [
          {
            similarity: 0.95,
            files: ['src/components/UserCard.vue', 'src/components/AdminCard.vue'],
            sharedStructure: ['CardHeader', 'CardContent', 'Badge'],
            recommendation: 'Extract shared layout to BaseCard.vue',
          },
        ],
        totalComponentsAudited: 10,
      };
      const text = formatSimilarTemplatesAsText(clusterResult);
      expect(text).toContain('95% similarity');
      expect(text).toContain('UserCard.vue');
      expect(text).toContain('AdminCard.vue');
      expect(text).toContain('Extract shared layout to BaseCard.vue');
    });
  });

  describe('Bundle Audit & Style Audit Text Formatters', () => {
    it('formats bundle audit results when clean with 0 warnings', () => {
      const cleanResult = {
        workspaceRoot: '/mock/app',
        totalFilesAudited: 25,
        heavyEagerImports: [],
        totalWarnings: 0,
      };
      const text = formatBundleAuditAsText(cleanResult);
      expect(text).toContain('Zero-Bloat Bundle & Island Architecture Audit');
      expect(text).toContain('No heavy synchronous imports or eager island hydration warnings detected');
    });

    it('formats design audit text cleanly when no violations are found', () => {
      const cleanDesign = {
        totalFilesAudited: 10,
        arbitraryTokens: [],
        a11yViolations: [],
        radiusDistribution: { 'rounded-md': 15 },
        totalIssues: 0,
      };
      const text = formatDesignAuditAsText(cleanDesign);
      expect(text).toContain('DESIGN SYSTEM & A11Y AUDIT');
      expect(text).toContain('Clean! No arbitrary Tailwind values found');
    });
  });
});
