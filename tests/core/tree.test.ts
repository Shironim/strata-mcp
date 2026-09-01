import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  getComponentTree,
  formatTreeAsText,
  resolveImportPath,
  resolveBarrelExport,
  extractLocalImports,
  isRenderedInContent,
} from '../../src/engine/tree';
import { createMcpServer } from '../../src/mcp';

const VUE_APP_DIR = join(import.meta.dir, '../mock-projects/vue-app');
const REACT_APP_DIR = join(import.meta.dir, '../mock-projects/react-app');
const ASTRO_APP_DIR = join(import.meta.dir, '../mock-projects/astro-app');

describe('Component Hierarchy Tree & Graph Engine (Phase 3 RFC)', () => {
  it('resolves relative import paths across extensions and barrel indexes', () => {
    const catalogView = join(VUE_APP_DIR, 'src/views/CatalogView.vue');
    const resolvedDirect = resolveImportPath(catalogView, '../components/ProductCard.vue');
    expect(resolvedDirect).toContain('ProductCard.vue');

    const resolvedBarrel = resolveImportPath(catalogView, '../components');
    expect(resolvedBarrel).toContain('index.ts');

    const barrelTarget = resolveBarrelExport(resolvedBarrel!, 'BaseButton');
    expect(barrelTarget).toContain('BaseButton.vue');
  });

  it('extracts static and dynamic lazy imports accurately', () => {
    const code = `
      import ProductCard from './ProductCard.vue';
      import { BaseButton as ActionBtn } from './components';
      const Modal = defineAsyncComponent(() => import('./Modal.vue'));
    `;
    const imports = extractLocalImports(code);
    expect(imports.length).toBe(3);

    const staticCard = imports.find((i) => i.name === 'ProductCard');
    expect(staticCard).toBeDefined();
    expect(staticCard!.isDynamic).toBe(false);

    const aliasedBtn = imports.find((i) => i.name === 'BaseButton');
    expect(aliasedBtn).toBeDefined();
    expect(aliasedBtn!.alias).toBe('ActionBtn');

    const dynamicModal = imports.find((i) => i.name === 'Modal');
    expect(dynamicModal).toBeDefined();
    expect(dynamicModal!.isDynamic).toBe(true);
  });

  it('checks if component is rendered in template or JSX', () => {
    const vueTemplate = `
      <template>
        <action-button>Submit</action-button>
        <ProductCard :item="x" />
      </template>
    `;
    expect(isRenderedInContent(vueTemplate, 'ActionButton')).toBe(true);
    expect(isRenderedInContent(vueTemplate, 'ProductCard')).toBe(true);
    expect(isRenderedInContent(vueTemplate, 'UnusedComponent')).toBe(false);
  });

  it('resolves downward component tree for Vue CatalogView.vue with barrel, alias, and lazy imports', async () => {
    const entryPath = join(VUE_APP_DIR, 'src/views/CatalogView.vue');
    const result = await getComponentTree({
      entryPath,
      maxDepth: 3,
    });

    expect(result.root.component).toBe('CatalogView.vue');
    expect(result.root.depth).toBe(0);
    expect(result.totalComponents).toBeGreaterThanOrEqual(4);

    const childNames = result.root.children.map((c) => c.component);
    expect(childNames).toContain('ProductCard.vue');
    expect(childNames).toContain('BaseButton.vue');
    expect(childNames).toContain('ProductModal.vue');

    // Verify alias on ActionButton
    const actionBtn = result.root.children.find((c) => c.component === 'BaseButton.vue');
    expect(actionBtn).toBeDefined();
    expect(actionBtn!.alias).toBe('ActionButton');

    // Verify dynamic/lazy on ProductModal
    const modal = result.root.children.find((c) => c.component === 'ProductModal.vue');
    expect(modal).toBeDefined();
    expect(modal!.isDynamic).toBe(true);

    // Verify nested children of ProductCard
    const card = result.root.children.find((c) => c.component === 'ProductCard.vue');
    expect(card).toBeDefined();
    const cardChildren = card!.children.map((c) => c.component);
    expect(cardChildren).toContain('BaseButton.vue');
    expect(cardChildren).toContain('StatusBadge.vue');
  });

  it('resolves downward component tree for React CatalogPage.tsx', async () => {
    const entryPath = join(REACT_APP_DIR, 'src/pages/CatalogPage.tsx');
    const result = await getComponentTree({
      entryPath,
      maxDepth: 3,
    });

    expect(result.root.component).toBe('CatalogPage.tsx');
    const childNames = result.root.children.map((c) => c.component);
    expect(childNames).toContain('ProductCard.tsx');
    expect(childNames).toContain('BaseButton.tsx');
  });

  it('resolves downward component tree for Astro catalog.astro with cross-framework islands', async () => {
    const entryPath = join(ASTRO_APP_DIR, 'src/pages/catalog.astro');
    const result = await getComponentTree({
      entryPath,
      maxDepth: 3,
    });

    expect(result.root.component).toBe('catalog.astro');
    const childNames = result.root.children.map((c) => c.component);
    expect(childNames).toContain('Layout.astro');
    expect(childNames).toContain('ProductCard.tsx');
    expect(childNames).toContain('BaseButton.vue');
    expect(childNames).toContain('ProductModal.vue');
  });

  it('formats tree into clean ASCII representation', async () => {
    const entryPath = join(VUE_APP_DIR, 'src/views/CatalogView.vue');
    const result = await getComponentTree({ entryPath, maxDepth: 3 });
    const formatted = formatTreeAsText(result);

    expect(formatted).toContain('CatalogView.vue (Root Page)');
    expect(formatted).toContain('├──');
    expect(formatted).toContain('└──');
    expect(formatted).toContain('(alias: ActionButton)');
    expect(formatted).toContain('[dynamic/lazy]');
    expect(formatted).toContain('Summary:');
  });

  it('invokes get_component_tree via MCP call tool handler', async () => {
    const server = createMcpServer();
    const handlers = (server as any)._requestHandlers;
    const callHandler = handlers.get('tools/call');

    const res = await callHandler({
      method: 'tools/call',
      params: {
        name: 'get_component_tree',
        arguments: {
          entry_path: join(VUE_APP_DIR, 'src/views/CatalogView.vue'),
          output_format: 'json',
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.root.component).toBe('CatalogView.vue');
    expect(parsed.totalComponents).toBeGreaterThanOrEqual(4);
  });
});
