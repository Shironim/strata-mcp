import { describe, expect, it } from 'bun:test';
import { resolveWorkspacePath } from '../../src/engine/path-resolver';
import { detectPropsDrilling } from '../../src/engine/tree';
import type { ComponentTreeNode } from '../../src/types';

describe('Strata MCP Engine Enhancements (Phase 1 - 4)', () => {
  describe('Phase 1: Smart Path Resolving', () => {
    it('resolves relative path against rootHint even if leading slash is provided', () => {
      const rootHint = '/mock-workspace/vue-app';
      const resolved = resolveWorkspacePath('/src/components/ProductCard.vue', rootHint);
      // Normalized path should be joined to rootHint rather than drive root
      expect(resolved.replace(/\\/g, '/')).toContain('/mock-workspace/vue-app/src/components/ProductCard.vue');
    });

    it('resolves relative path without leading slash against rootHint', () => {
      const rootHint = '/mock-workspace/vue-app';
      const resolved = resolveWorkspacePath('src/components/ProductCard.vue', rootHint);
      expect(resolved.replace(/\\/g, '/')).toContain('/mock-workspace/vue-app/src/components/ProductCard.vue');
    });
  });

  describe('Phase 2: Props Drilling Diagnostics', () => {
    it('detects 2-level props drilling from Origin -> Intermediate -> Target', () => {
      const mockTree: ComponentTreeNode = {
        component: 'CatalogView.vue',
        filePath: '/src/views/CatalogView.vue',
        depth: 0,
        children: [
          {
            component: 'ProductCard.vue',
            filePath: '/src/components/ProductCard.vue',
            depth: 1,
            passedProps: [
              { propName: 'status', expression: 'product.status' },
            ],
            children: [
              {
                component: 'StatusBadge.vue',
                filePath: '/src/components/StatusBadge.vue',
                depth: 2,
                passedProps: [
                  { propName: 'status', expression: 'status' },
                ],
                children: [],
              },
            ],
          },
        ],
      };

      const alerts = detectPropsDrilling(mockTree);
      expect(alerts.length).toBe(1);
      expect(alerts[0].origin).toBe('CatalogView.vue');
      expect(alerts[0].drilledThrough).toEqual(['ProductCard.vue']);
      expect(alerts[0].target).toBe('StatusBadge.vue');
      expect(alerts[0].depth).toBe(2);
      expect(alerts[0].recommendation).toContain('Provide/Inject or Composable candidate');
    });
  });
});
