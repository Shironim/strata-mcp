import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapSourceFile } from '../../src/engine/source-map';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';

describe('01 - Vue.js Framework: AST-Based Canonical Rules & Mapping', () => {

  // =========================================================================
  // 3. Source Mapping: Nested Template Region Expansion (Task V03)
  // =========================================================================
  describe('Nested Template Region Expansion', () => {
    test('maps nested semantic elements (form, table, v-for) inside template', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-vue-nest-'));
      const filePath = join(testDir, 'Nested.vue');
      const code = `<template>
  <div class="layout-wrapper">
    <form @submit.prevent="submit">
      <input v-model="email" />
    </form>
    <table class="data-table">
      <tr v-for="row in rows" :key="row.id">
        <td>{{ row.val }}</td>
      </tr>
    </table>
  </div>
</template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const map = await mapSourceFile(filePath);

        expect(map.status).toBe('complete');
        const templateRegion = map.regions.find(r => r.name === 'template');
        expect(templateRegion).toBeDefined();

        // Top level in template is div.layout-wrapper
        const wrapper = templateRegion?.children?.[0];
        expect(wrapper?.name).toBe('div');
        expect(wrapper?.children).toBeDefined();

        // Nested children should include form and table
        const childTags = wrapper?.children?.map(c => c.name);
        expect(childTags).toContain('form');
        expect(childTags).toContain('table');

        // Table should have tr with v-for
        const table = wrapper?.children?.find(c => c.name === 'table');
        expect(table?.children).toBeDefined();
        const tr = table?.children?.find(c => c.name === 'tr');
        expect(tr?.attributes?.['v-for']).toBe('row in rows');

        // Slicing the form region ref returns the exact form HTML
        const formRegion = wrapper?.children?.find(c => c.name === 'form');
        const slicedForm = await readSourceRef(filePath, formRegion!.ref);
        expect(slicedForm).toContain('<form @submit.prevent="submit">');
        expect(slicedForm).toContain('</form>');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });
});

