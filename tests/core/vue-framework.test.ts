import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapSourceFile } from '../../src/engine/source-map';
import { runCanonAudit } from '../../src/engine/canon';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';
import { detectReactivitySmells } from '../../src/engine/reactivity';

describe('01 - Vue.js Framework: AST-Based Canonical Rules & Mapping', () => {
  // =========================================================================
  // 1. Template AST Rules (@vue/compiler-dom)
  // =========================================================================
  describe('Template AST Rules', () => {
    test('vue/no-v-if-with-v-for: detects simultaneous v-if and v-for on same element', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-v-if-for-'));
      const filePath = join(testDir, 'BadList.vue');
      const code = `<template>
  <ul>
    <li v-for="user in users" v-if="user.isActive" :key="user.id">{{ user.name }}</li>
  </ul>
</template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/no-v-if-with-v-for');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.category).toBe('rendering');
        expect(d?.smell.title).toContain('v-if and v-for on the same <li');

        const sliced = await readSourceRef(filePath, d!.fact.ref);
        expect(sliced).toContain('v-for="user in users"');
        expect(sliced).toContain('v-if="user.isActive"');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/require-v-for-key: flags missing :key as error and array index key as warning', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-v-for-key-'));
      const filePath = join(testDir, 'KeyTest.vue');
      const code = `<template>
  <div>
    <!-- Missing key -->
    <div v-for="a in listA">{{ a }}</div>

    <!-- Index as key -->
    <div v-for="(b, idx) in listB" :key="idx">{{ b }}</div>
  </div>
</template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const keyDiags = diags.filter(x => x.ruleId === 'vue/require-v-for-key');

        expect(keyDiags.length).toBe(2);

        const missing = keyDiags.find(x => x.severity === 'error');
        expect(missing).toBeDefined();
        expect(missing?.smell.title).toContain('missing :key');

        const indexKey = keyDiags.find(x => x.severity === 'warning');
        expect(indexKey).toBeDefined();
        expect(indexKey?.smell.title).toContain("uses array index 'idx'");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Negative Test: v-for with unique domain key is NOT flagged', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-v-for-ok-'));
      const filePath = join(testDir, 'GoodKey.vue');
      const code = `<template>
  <div v-for="item in items" :key="item.id">{{ item.name }}</div>
</template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        expect(diags.find(x => x.ruleId === 'vue/require-v-for-key')).toBeUndefined();
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/no-prop-mutation in template: flags v-model="props.xxx"', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-v-model-prop-'));
      const filePath = join(testDir, 'MutatingModel.vue');
      const code = `<template>
  <input v-model="props.username" />
</template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/no-prop-mutation');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.smell.title).toContain('props.username');

        const sliced = await readSourceRef(filePath, d!.fact.ref);
        expect(sliced).toBe('v-model="props.username"');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 2. Script AST Rules (TypeScript AST)
  // =========================================================================
  describe('Script AST Rules', () => {
    test('vue/no-prop-mutation in script: flags direct assignment and unary increments without false positives on comments', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-script-prop-'));
      const filePath = join(testDir, 'PropMut.vue');
      const code = `<script setup lang="ts">
const props = defineProps<{ count: number; name: string }>();

// This is a comment: props.count = 999;
/* Multi-line comment: props.name = 'fake'; */

function increment() {
  props.count++;
  props.name = 'new name';
}
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const propMutations = diags.filter(x => x.ruleId === 'vue/no-prop-mutation');

        // Should flag props.count++ and props.name = 'new name' (comments must be ignored!)
        expect(propMutations.length).toBe(2);

        const unary = propMutations.find(x => x.fact.snippet.includes('props.count++'));
        expect(unary).toBeDefined();
        expect(unary?.severity).toBe('error');

        const assignment = propMutations.find(x => x.fact.snippet.includes("props.name = 'new name'"));
        expect(assignment).toBeDefined();
        expect(assignment?.severity).toBe('error');

        // Check legacy detectReactivitySmells ignores comments too
        const legacySmells = await detectReactivitySmells({ path: filePath, code });
        expect(legacySmells.filter(s => s.line <= 5).length).toBe(0);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/no-reactive-destructure: flags destructuring reactive() without toRefs', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-reactive-destruct-'));
      const filePath = join(testDir, 'ReactiveDestruct.vue');
      const code = `<script setup lang="ts">
import { reactive } from 'vue';

const state = reactive({ count: 0, title: 'Strata' });
const { count, title } = state;
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/no-reactive-destructure');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('warning');
        expect(d?.canon.summary).toContain('toRefs()');

        const sliced = await readSourceRef(filePath, d!.fact.ref);
        expect(sliced).toBe('const { count, title } = state;');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/no-async-computed: flags async callback in computed()', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-async-computed-'));
      const filePath = join(testDir, 'AsyncComp.vue');
      const code = `<script setup lang="ts">
import { computed } from 'vue';

const profile = computed(async () => {
  return await fetch('/api/me');
});
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/no-async-computed');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.canon.summary).toContain('useAsyncState');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/computed-over-watch: flags watch() that only assigns to derived state', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-watch-derived-'));
      const filePath = join(testDir, 'DerivedWatch.vue');
      const code = `<script setup lang="ts">
import { ref, watch } from 'vue';

const first = ref('John');
const full = ref('');

watch(first, (val) => {
  full.value = val + ' Doe';
});
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/computed-over-watch');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('warning');
        expect(d?.canon.summary).toContain('computed()');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/prefer-define-model: flags manual modelValue prop and emit in Vue 3.4+', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-define-model-'));
      const filePath = join(testDir, 'ManualVModel.vue');
      const code = `<script setup lang="ts">
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', val: string): void }>();
</script>`;

      try {
        // Vue 3.4 project
        await fs.writeFile(join(testDir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.4.21' } }));
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/prefer-define-model');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('info');
        expect(d?.canon.summary).toContain('defineModel');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('vue/props-destructure-version: recommends native destructure over withDefaults in Vue 3.5+', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-with-defaults-'));
      const filePath = join(testDir, 'WithDefaults.vue');
      const code = `<script setup lang="ts">
const props = withDefaults(defineProps<{ title?: string }>(), {
  title: 'Default Title'
});
</script>`;

      try {
        // Vue 3.5 project
        await fs.writeFile(join(testDir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.13' } }));
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        const d = diags.find(x => x.ruleId === 'vue/props-destructure-version');

        expect(d).toBeDefined();
        expect(d?.severity).toBe('info');
        expect(d?.smell.title).toContain('withDefaults() is Redundant');
        expect(d?.canon.canonicalCode).toContain("const { title = 'Default' }");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

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

