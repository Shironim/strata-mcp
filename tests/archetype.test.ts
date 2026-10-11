import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  auditPageArchetypeDrift,
  diffPageArchetypes,
  extractPageArchetypeFromSource,
  extractReactSemanticSections,
  extractVueSemanticSections,
  formatArchetypeAuditAsText,
} from '../src/engine/archetype';
import { extractComponentContract } from '../src/engine/contract';
import { auditFrontendTool } from '../src/tools/audit-frontend';

const GOLDEN_VUE_PAGE = `<script setup lang="ts">
import { ref } from 'vue';
const search = ref('');
const statusFilter = ref('all');
const items = ref([]);
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-6 space-y-6">
    <div class="flex items-center justify-between">
      <PageTitle title="Products Catalog" />
      <BaseButton variant="primary" @click="onCreate">Add Product</BaseButton>
    </div>

    <div class="flex items-center gap-4">
      <SearchInput v-model="search" placeholder="Search products..." />
      <SelectFilter v-model="statusFilter" :options="statuses" />
    </div>

    <div class="bg-card rounded-lg shadow">
      <DataTable :rows="items" :columns="columns" />
      <EmptyState v-if="items.length === 0" message="No products found" />
      <PaginationBar :total="100" :per-page="20" />
    </div>
  </div>
</template>
`;

const DRIFTED_VUE_PAGE = `<script setup lang="ts">
import { ref } from 'vue';
const items = ref([]);
</script>

<template>
  <div class="p-2">
    <div class="bg-white">
      <DataTable :rows="items" />
    </div>

    <div class="flex items-center justify-between">
      <h1>Orders List</h1>
      <button class="bg-blue-500 text-white px-4 py-2" @click="onCreate">New Order</button>
    </div>
  </div>
</template>
`;

const GOLDEN_REACT_PAGE = `import React from 'react';

export default function ProductsPage({ items, total }: any) {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <header className="flex items-center justify-between">
        <PageHeader title="Products" />
        <PrimaryButton onClick={() => {}}>Create</PrimaryButton>
      </header>
      <div className="flex items-center gap-3">
        <SearchBox query="" />
        <FilterSelect options={[]} />
      </div>
      <section className="flex flex-col gap-4">
        <ProductsTable data={items} />
        {items.length === 0 && <EmptyPlaceholder />}
        <TablePagination total={total} />
      </section>
    </div>
  );
}
`;

const DRIFTED_REACT_PAGE = `import React from 'react';

export default function OrdersPage({ items }: any) {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <header className="flex items-center justify-between">
        <PageHeader title="Orders" />
        <button onClick={() => {}}>Raw Create</button>
      </header>
      <div className="flex items-center gap-3">
        <input type="text" placeholder="Search..." />
      </div>
      <section className="flex flex-col gap-4">
        <ProductsTable data={items} />
      </section>
    </div>
  );
}
`;

describe('Live Page Archetype & Structural Drift Engine', () => {
  test('extractVueSemanticSections partitions div-soup into semantic sections accurately', () => {
    const archetype = extractPageArchetypeFromSource(
      'pages/products/index.vue',
      GOLDEN_VUE_PAGE,
      'vue'
    );

    expect(archetype.rootWrapper?.tag).toBe('div');
    expect(archetype.rootWrapper?.layoutTokens).toContain('max-w-7xl');
    expect(archetype.sections.length).toBe(3);

    expect(archetype.sections[0].kind).toBe('page-header');
    expect(archetype.sections[0].components.map((c) => c.name)).toEqual([
      'PageTitle',
      'BaseButton',
    ]);

    expect(archetype.sections[1].kind).toBe('filter-toolbar');
    expect(archetype.sections[1].components.map((c) => c.name)).toEqual([
      'SearchInput',
      'SelectFilter',
    ]);

    expect(archetype.sections[2].kind).toBe('data-content');
    expect(archetype.sections[2].components.map((c) => c.name)).toEqual([
      'DataTable',
      'EmptyState',
      'PaginationBar',
    ]);
    expect(archetype.sections[2].components[1].conditional).toContain('v-if');
  });

  test('extractReactSemanticSections partitions TSX JSX into semantic sections accurately', () => {
    const sections = extractReactSemanticSections(GOLDEN_REACT_PAGE);
    expect(sections.length).toBe(3);
    expect(sections[0].kind).toBe('page-header');
    expect(sections[1].kind).toBe('filter-toolbar');
    expect(sections[2].kind).toBe('data-content');
    expect(sections[2].components.some((c) => c.name === 'EmptyPlaceholder' && c.conditional?.includes('jsx-if'))).toBe(true);
  });

  test('diffPageArchetypes detects all 5 deterministic drift violations on Vue pages', () => {
    const exemplar = extractPageArchetypeFromSource('pages/products/index.vue', GOLDEN_VUE_PAGE, 'vue');
    const target = extractPageArchetypeFromSource('pages/orders/index.vue', DRIFTED_VUE_PAGE, 'vue');

    const audit = diffPageArchetypes(target, exemplar);
    expect(audit.conforms).toBe(false);
    expect(audit.score).toBeLessThan(80);

    const codes = audit.violations.map((v) => v.code);
    expect(codes).toContain('CONTAINER_DNA_MISMATCH');
    expect(codes).toContain('MISSING_SEMANTIC_SECTION');
    expect(codes).toContain('SECTION_ORDER_DRIFT');
    expect(codes).toContain('RAW_HTML_SUBSTITUTION');
    expect(codes).toContain('MISSING_COMPANION_COMPONENT');

    const rawBtnViolation = audit.violations.find((v) => v.code === 'RAW_HTML_SUBSTITUTION');
    expect(rawBtnViolation?.expected).toBe('<BaseButton>');
    expect(rawBtnViolation?.actual).toBe('<button>');

    const formatted = formatArchetypeAuditAsText(audit);
    expect(formatted).toContain('RAW_HTML_SUBSTITUTION');
    expect(formatted).toContain('<BaseButton>');
  });

  test('diffPageArchetypes detects raw HTML substitution and missing companions on React TSX pages', () => {
    const exemplar = extractPageArchetypeFromSource('app/products/page.tsx', GOLDEN_REACT_PAGE, 'react');
    const target = extractPageArchetypeFromSource('app/orders/page.tsx', DRIFTED_REACT_PAGE, 'react');

    const audit = diffPageArchetypes(target, exemplar);
    expect(audit.conforms).toBe(false);

    const rawViolations = audit.violations.filter((v) => v.code === 'RAW_HTML_SUBSTITUTION');
    expect(rawViolations.length).toBe(2);
    expect(rawViolations.map((v) => v.expected)).toContain('<PrimaryButton>');
    expect(rawViolations.map((v) => v.expected)).toContain('<SearchBox>');

    const companionViolations = audit.violations.filter((v) => v.code === 'MISSING_COMPANION_COMPONENT');
    expect(companionViolations.length).toBe(2);
  });

  test('auditPageArchetypeDrift auto-discovers richest sibling exemplar and integrates with inspect_component & audit_frontend', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'strata-archetype-'));
    try {
      const productsDir = join(tmpRoot, 'pages', 'products');
      const ordersDir = join(tmpRoot, 'pages', 'orders');
      mkdirSync(productsDir, { recursive: true });
      mkdirSync(ordersDir, { recursive: true });

      const exemplarPath = join(productsDir, 'index.vue');
      const targetPath = join(ordersDir, 'index.vue');

      writeFileSync(exemplarPath, GOLDEN_VUE_PAGE, 'utf8');
      writeFileSync(targetPath, DRIFTED_VUE_PAGE, 'utf8');

      // 1. Auto-sibling discovery (no exemplarPath provided)
      const autoResult = await auditPageArchetypeDrift({
        targetPath,
        workspaceRoot: tmpRoot,
      });
      expect(autoResult.exemplarFile).toContain('products/index.vue');
      expect(autoResult.conforms).toBe(false);

      // 2. inspect_component contract includes layoutStructure.sections
      const contract = await extractComponentContract(exemplarPath);
      expect(contract.layoutStructure?.sections?.length).toBe(3);
      expect(contract.layoutStructure?.sections?.[0].kind).toBe('page-header');

      // 3. MCP audit_frontend handler with target: 'archetype-drift'
      const mcpResponse = await auditFrontendTool.handler({
        target: 'archetype-drift',
        path: targetPath,
        exemplar_path: exemplarPath,
      });
      expect(mcpResponse.isError).toBeUndefined();
      expect(mcpResponse.content[0].text).toContain('RAW_HTML_SUBSTITUTION');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('handles nested Vue <template #slot> and <template v-if> without premature truncation', () => {
    const vueWithNestedTemplates = `<script setup lang="ts">
const items = [];
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-6 space-y-6">
    <header class="flex items-center justify-between">
      <PageTitle title="Inventory" />
    </header>
    <div class="bg-card">
      <DataTable :rows="items">
        <template #header>
          <span>Custom Slot Header</span>
        </template>
      </DataTable>
      <template v-if="items.length === 0">
        <EmptyState message="No inventory" />
      </template>
    </div>
    <footer class="flex justify-end">
      <BaseButton variant="primary">Export</BaseButton>
    </footer>
  </div>
</template>
`;

    const archetype = extractPageArchetypeFromSource(
      'pages/inventory/index.vue',
      vueWithNestedTemplates,
      'vue'
    );

    expect(archetype.rootWrapper?.line).toBe(6);
    expect(archetype.sections.map((s) => s.kind)).toEqual([
      'page-header',
      'data-content',
      'action-footer',
    ]);
    const emptyState = archetype.sections[1].components.find((c) => c.name === 'EmptyState');
    expect(emptyState?.conditional).toContain('v-if: items.length === 0');
  });

  test('handles React TSX with early guard return, inline .map() JSX callbacks, and arrow root without parens', () => {
    const complexReactPage = `import React from 'react';

export const ComplexOrdersPage = ({ items, isLoading }: any) => {
  if (isLoading) return <LoadingSpinner />;

  return <main onClick={() => console.log('clicked')} className="max-w-7xl mx-auto px-6 py-8 space-y-6">
    <header className="flex items-center justify-between">
      <PageHeader title="Orders" />
      <PrimaryButton onClick={() => {}}>Create</PrimaryButton>
    </header>
    <section className="flex flex-col gap-4">
      <table>
        <tbody>
          {items.map((item: any) => (
            <tr key={item.id}>
              <td>{item.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <EmptyPlaceholder />}
    </section>
  </main>;
};
`;

    const archetype = extractPageArchetypeFromSource(
      'app/orders/page.tsx',
      complexReactPage,
      'react'
    );

    expect(archetype.rootWrapper?.tag).toBe('main');
    expect(archetype.rootWrapper?.line).toBe(6);
    expect(archetype.rootWrapper?.layoutTokens).toContain('max-w-7xl');
    expect(archetype.sections.map((s) => s.kind)).toEqual([
      'page-header',
      'data-content',
    ]);
  });
});


