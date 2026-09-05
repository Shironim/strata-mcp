import { describe, expect, it } from 'bun:test';
import { resolveWorkspacePath } from '../../src/engine/path-resolver';
import { detectPropsDrilling } from '../../src/engine/tree';
import { detectReactivitySmells } from '../../src/engine/reactivity';
import { auditDesignTokens } from '../../src/engine/style-audit';
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

  describe('Phase 3: Reactivity Smells Detection', () => {
    it('detects Vue defineProps destructuring without toRefs', async () => {
      const vueCode = `
<script setup lang="ts">
interface Props {
  title: string;
  count: number;
}
const { title, count } = defineProps<Props>();
</script>
<template><div>{{ title }}</div></template>
      `;

      const smells = await detectReactivitySmells({
        path: '/mock/TestComponent.vue',
        code: vueCode,
      });

      expect(smells.length).toBeGreaterThan(0);
      const destructureSmell = smells.find((s) => s.type === 'vue-props-destructure');
      expect(destructureSmell).toBeDefined();
      expect(destructureSmell?.message).toContain('loss of reactivity');
    });

    it('detects direct prop mutation via v-model="props.xxx"', async () => {
      const vueCode = `
<script setup>
const props = defineProps(['modelValue']);
</script>
<template>
  <input v-model="props.modelValue" />
</template>
      `;

      const smells = await detectReactivitySmells({
        path: '/mock/FormInput.vue',
        code: vueCode,
      });

      const mutationSmell = smells.find((s) => s.type === 'vue-prop-mutation');
      expect(mutationSmell).toBeDefined();
      expect(mutationSmell?.severity).toBe('error');
    });

    it('detects React inline handler in .map() loop', async () => {
      const reactCode = `
export function ProductList({ items }) {
  return (
    <div>
      {items.map((item) => (
        <ProductCard key={item.id} onClick={() => alert(item.id)} />
      ))}
    </div>
  );
}
      `;

      const smells = await detectReactivitySmells({
        path: '/mock/ProductList.tsx',
        code: reactCode,
      });

      const mapSmell = smells.find((s) => s.type === 'react-inline-in-loop');
      expect(mapSmell).toBeDefined();
      expect(mapSmell?.message).toContain('Inline arrow function callback allocated inside .map()');
    });
  });

  describe('Phase 4: Design Token & a11y Audit', () => {
    it('audits arbitrary classes and a11y violations across fixtures', async () => {
      const result = await auditDesignTokens({
        targetPath: 'tests/fixtures',
      });

      expect(result.totalFilesAudited).toBeGreaterThan(0);
      expect(Array.isArray(result.arbitraryTokens)).toBe(true);
      expect(Array.isArray(result.a11yViolations)).toBe(true);
      expect(typeof result.radiusDistribution).toBe('object');
    });
  });
});
