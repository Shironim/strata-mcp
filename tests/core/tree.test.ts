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

  it('checks if dynamic component maps are recognized across Vue, React, and Astro', () => {
    // 1. Vue/Nuxt dynamic component map (:is="componentMap[tab]")
    const vueDynamicMap = `
      <template>
        <component :is="componentMap[activeTab]" />
      </template>
      <script setup>
      import LaptopSection from './LaptopSection.vue';
      import PhoneSection from './PhoneSection.vue';
      import UnusedSection from './UnusedSection.vue';

      const componentMap = {
        laptop: LaptopSection,
        phone: PhoneSection,
      };
      </script>
    `;
    expect(isRenderedInContent(vueDynamicMap, 'LaptopSection')).toBe(true);
    expect(isRenderedInContent(vueDynamicMap, 'PhoneSection')).toBe(true);
    expect(isRenderedInContent(vueDynamicMap, 'UnusedSection')).toBe(false);

    // 2. React / Next.js dynamic JSX lookup map
    const reactDynamicMap = `
      import WidgetA from './WidgetA';
      import WidgetB from './WidgetB';
      import UnusedWidget from './UnusedWidget';

      const WIDGETS: Record<string, React.ComponentType> = {
        a: WidgetA,
        b: WidgetB,
      };

      export default function Dashboard({ type }) {
        const SelectedWidget = WIDGETS[type];
        return <div><SelectedWidget /></div>;
      }
    `;
    expect(isRenderedInContent(reactDynamicMap, 'WidgetA')).toBe(true);
    expect(isRenderedInContent(reactDynamicMap, 'WidgetB')).toBe(true);
    expect(isRenderedInContent(reactDynamicMap, 'UnusedWidget')).toBe(false);

    // 3. React.createElement / jsx
    const reactCreateElem = `
      import DynamicModal from './DynamicModal';
      export function renderModal() {
        return React.createElement(DynamicModal, { open: true });
      }
    `;
    expect(isRenderedInContent(reactCreateElem, 'DynamicModal')).toBe(true);

    // 4. Astro frontmatter dynamic component map
    const astroDynamicMap = `
      ---
      import HeroOne from './HeroOne.astro';
      import HeroTwo from './HeroTwo.astro';
      import UnusedHero from './UnusedHero.astro';

      const HEROS = {
        v1: HeroOne,
        v2: HeroTwo,
      };
      const ActiveHero = HEROS[Astro.props.variant];
      ---
      <section>
        <ActiveHero />
      </section>
    `;
    expect(isRenderedInContent(astroDynamicMap, 'HeroOne')).toBe(true);
    expect(isRenderedInContent(astroDynamicMap, 'HeroTwo')).toBe(true);
    expect(isRenderedInContent(astroDynamicMap, 'UnusedHero')).toBe(false);
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

  it('detects unresolved dynamic and polymorphic components and flags warnings', async () => {
    const { extractDynamicWarnings } = await import('../../src/engine/tree');
    const templateContent = `
      <template>
        <div>
          <component :is="activeTab" />
          <Dialog.Trigger asChild>
            <button>Open</button>
          </Dialog.Trigger>
          <StaticHeader />
        </div>
      </template>
    `;

    const warnings = extractDynamicWarnings(templateContent, new Set(['StaticHeader']));
    expect(warnings.length).toBe(2);
    expect(warnings[0].component).toBe('<component :is="activeTab">');
    expect(warnings[0].warning).toContain('Dynamic/polymorphic component');
    expect(warnings[1].component).toBe('<Dialog.Trigger asChild>');
    expect(warnings[1].warning).toContain('Polymorphic delegate component');
  });
});
