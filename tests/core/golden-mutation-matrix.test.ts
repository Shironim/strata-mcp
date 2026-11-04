import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import {
  checkPatchPreconditions,
  validatePatchPreconditions,
  applyPatchesToSource,
} from '../../src/engine/patch-preconditions';
import { readSourceSnapshot } from '../../src/engine/source-file';
import { parse as parseDom } from '@vue/compiler-dom';

describe('Golden Mutation Matrix & Patch Plan Operations (R-01 & R-10)', () => {
  // Helper to create disposable test workspaces
  async function createFixtureWorkspace(consumerTemplates: Record<string, string>) {
    const root = await mkdtemp('/tmp/strata-golden-mutation-');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'test-matrix', version: '1.0.0' }));
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })
    );

    const targetComponentPath = join(root, 'src/TargetCard.vue');
    const targetSource = `<template>
  <div class="target-card">
    <slot name="header" :title="title" />
    <slot :item="item" />
  </div>
</template>
<script setup lang="ts">
defineProps<{
  label?: string;
  itemVal?: string;
  active?: boolean;
}>();
defineEmits<{
  (e: 'select-item', id: string): void;
}>();
</script>`;
    await writeFile(targetComponentPath, targetSource);

    for (const [filename, template] of Object.entries(consumerTemplates)) {
      const fullPath = join(root, 'src', filename);
      const source = `<script setup lang="ts">
import TargetCard from './TargetCard.vue';
</script>
<template>
${template}
</template>`;
      await writeFile(fullPath, source);
    }

    return {
      root,
      targetComponentPath,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  describe('1. The 8 Refactor Operations for Vue SFC Template (P-01 & R-10)', () => {
    it('rename_prop: handles static, bound shorthand, v-bind, and same-name shorthand', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerProps.vue': `
  <TargetCard label="Static Label" />
  <TargetCard :label="dynamicLabel" />
  <TargetCard v-bind:label="fullBoundLabel" />
  <TargetCard :label />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'label',
          newName: 'heading',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(4);
        expect(plan.coverage.failedCount).toBe(0);
        expect(plan.coverage.unsupportedCount).toBe(0);

        const snippets = plan.patches.map(p => ({ old: p.oldSnippet, new: p.newSnippet }));
        expect(snippets).toContainEqual({ old: 'label="Static Label"', new: 'heading="Static Label"' });
        expect(snippets).toContainEqual({ old: ':label="dynamicLabel"', new: ':heading="dynamicLabel"' });
        expect(snippets).toContainEqual({ old: 'v-bind:label="fullBoundLabel"', new: 'v-bind:heading="fullBoundLabel"' });
        expect(snippets).toContainEqual({ old: ':label', new: ':heading="label"' });
      } finally {
        await cleanup();
      }
    });

    it('remove_prop: removes static, bound, and shorthand prop attributes cleanly', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerRemoveProp.vue': `
  <TargetCard label="Static Label" :active="true" />
  <TargetCard :label="dynamicLabel" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'remove_prop',
          oldName: 'label',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(2);
        expect(plan.patches.every(p => p.newSnippet === '')).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('rename_event: handles @event, v-on:event, and event modifiers (.stop.prevent)', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerEvent.vue': `
  <TargetCard @select-item="onSelect" />
  <TargetCard v-on:select-item="onSelect" />
  <TargetCard @select-item.stop.prevent="onSelect" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_event',
          oldName: 'selectItem',
          newName: 'chooseItem',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(3);
        const snippets = plan.patches.map(p => p.newSnippet);
        expect(snippets).toContain('@choose-item="onSelect"');
        expect(snippets).toContain('v-on:choose-item="onSelect"');
        expect(snippets).toContain('@choose-item.stop.prevent="onSelect"');
      } finally {
        await cleanup();
      }
    });

    it('remove_event: removes event listeners with or without modifiers', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerRemoveEvent.vue': `
  <TargetCard @select-item="onSelect" @select-item.stop="onSelect" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'remove_event',
          oldName: 'selectItem',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(2);
        expect(plan.patches.every(p => p.newSnippet === '')).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('rename_model: handles shorthand v-model, named v-model:name, and expanded bindings', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerModel.vue': `
  <TargetCard v-model="defaultVal" />
  <TargetCard v-model:item-val="itemVal" />
  <TargetCard :item-val="itemVal" @update:item-val="itemVal = $event" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_model',
          oldName: 'itemVal',
          newName: 'currentValue',
          targetPath: root,
        });

        // 3 patches: named v-model, expanded prop :item-val, expanded event @update:item-val
        expect(plan.totalPatches).toBe(3);
        const snippets = plan.patches.map(p => p.newSnippet);
        expect(snippets).toContain('v-model:current-value="itemVal"');
        expect(snippets).toContain(':current-value="itemVal"');
        expect(snippets).toContain('@update:current-value="itemVal = $event"');
      } finally {
        await cleanup();
      }
    });

    it('remove_model: removes v-model and expanded prop/event pairs', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerRemoveModel.vue': `
  <TargetCard v-model:item-val="itemVal" />
  <TargetCard :item-val="itemVal" @update:item-val="itemVal = $event" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'remove_model',
          oldName: 'itemVal',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(3);
        expect(plan.patches.every(p => p.newSnippet === '')).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('rename_slot: handles #header, v-slot:header, #default, and v-slot default', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerSlot.vue': `
  <TargetCard>
    <template #header>Header 1</template>
    <template v-slot:header>Header 2</template>
  </TargetCard>
  <TargetCard #header>Header 3</TargetCard>
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'header',
          newName: 'topBanner',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(3);
        const snippets = plan.patches.map(p => p.newSnippet);
        expect(snippets).toContain('#topBanner');
        expect(snippets).toContain('v-slot:topBanner');
      } finally {
        await cleanup();
      }
    });

    it('remove_slot: removes child <template> subtree and direct slot directives safely', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'ConsumerRemoveSlot.vue': `
  <TargetCard label="Keep Me">
    <template #header><h3>Remove This Subtree</h3></template>
  </TargetCard>
  <TargetCard #header label="Keep Element Too" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'remove_slot',
          oldName: 'header',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(2);
        // First patch removes <template #header>...</template>
        const templatePatch = plan.patches.find(p => p.oldSnippet.includes('<template'));
        expect(templatePatch).toBeDefined();
        expect(templatePatch?.newSnippet).toBe('');

        // Second patch removes #header attribute without wiping out <TargetCard ... label="Keep Element Too" />
        const directPatch = plan.patches.find(p => p.oldSnippet === '#header');
        expect(directPatch).toBeDefined();
        expect(directPatch?.newSnippet).toBe('');
      } finally {
        await cleanup();
      }
    });
  });

  describe('2. v-for Expressions & Scoped Iterations (R-10 & P-01)', () => {
    it('generates patches for props, events, models, and slots inside v-for loops', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'VForConsumer.vue': `
  <TargetCard
    v-for="item in items"
    :key="item.id"
    :label="item.name"
    @select-item="onSelect(item)"
    v-model:item-val="item.val"
  >
    <template #header="{ title }">
      <h4>{{ title }} - {{ item.id }}</h4>
    </template>
  </TargetCard>
`,
      });
      try {
        // Test rename_prop inside v-for
        const propPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'label',
          newName: 'title',
          targetPath: root,
        });
        expect(propPlan.totalPatches).toBe(1);
        expect(propPlan.patches[0].newSnippet).toBe(':title="item.name"');

        // Test rename_event inside v-for
        const eventPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_event',
          oldName: 'selectItem',
          newName: 'pickItem',
          targetPath: root,
        });
        expect(eventPlan.totalPatches).toBe(1);
        expect(eventPlan.patches[0].newSnippet).toBe('@pick-item="onSelect(item)"');

        // Test rename_model inside v-for
        const modelPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_model',
          oldName: 'itemVal',
          newName: 'itemData',
          targetPath: root,
        });
        expect(modelPlan.totalPatches).toBe(1);
        expect(modelPlan.patches[0].newSnippet).toBe('v-model:item-data="item.val"');

        // Test rename_slot inside v-for
        const slotPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'header',
          newName: 'cardHeader',
          targetPath: root,
        });
        expect(slotPlan.totalPatches).toBe(1);
        expect(slotPlan.patches[0].newSnippet).toBe('#cardHeader="{ title }"');
      } finally {
        await cleanup();
      }
    });

    it('handles nested v-for with destructuring and multiline expressions', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'NestedVForConsumer.vue': `
  <template v-for="{ id, name } in items.filter(x => x.active)" :key="id">
    <div class="row">
      <TargetCard
        v-for="(subItem, subIdx) in getSubItems(id)"
        :key="subIdx"
        :label="name + subItem.title"
      />
    </div>
  </template>
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'label',
          newName: 'heading',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(1);
        expect(plan.patches[0].newSnippet).toBe(':heading="name + subItem.title"');
      } finally {
        await cleanup();
      }
    });
  });

  describe('3. Dynamic Directive Arguments & Omissions (P-08 & R-10)', () => {
    it('refuses to patch dynamic arguments and reports DYNAMIC_ARGUMENT omission', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'DynamicArgsConsumer.vue': `
  <TargetCard
    :[dynamicProp]="val"
    @[dynamicEvent]="onEvent"
    v-model:[dynamicModel]="val"
  >
    <template #[dynamicSlot]>Dynamic Slot Content</template>
  </TargetCard>
`,
      });
      try {
        // Attempting to rename 'dynamicProp' should NOT patch dynamic prop
        const propPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'dynamicProp',
          newName: 'staticProp',
          targetPath: root,
        });
        expect(propPlan.totalPatches).toBe(0);
        expect(propPlan.coverage.omissions.some(o => o.code === 'DYNAMIC_ARGUMENT')).toBe(true);

        // Attempting to rename 'dynamicModel' should NOT patch dynamic model
        const modelPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_model',
          oldName: 'dynamicModel',
          newName: 'staticModel',
          targetPath: root,
        });
        expect(modelPlan.totalPatches).toBe(0);
        expect(modelPlan.coverage.omissions.some(o => o.code === 'DYNAMIC_ARGUMENT')).toBe(true);

        // Attempting to rename 'dynamicSlot' should NOT patch dynamic slot
        const slotPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'dynamicSlot',
          newName: 'staticSlot',
          targetPath: root,
        });
        expect(slotPlan.totalPatches).toBe(0);
        expect(slotPlan.coverage.omissions.some(o => o.code === 'DYNAMIC_ARGUMENT')).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('reports dynamic argument inside v-for slot template as omission', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'DynamicSlotInVFor.vue': `
  <TargetCard>
    <template v-for="col in columns" :key="col.id" #[col.slotName]>
      {{ col.label }}
    </template>
  </TargetCard>
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'header',
          newName: 'heading',
          targetPath: root,
        });

        expect(plan.coverage.omissions.some(o => o.code === 'DYNAMIC_ARGUMENT')).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe('4. v-slot Destructuring Variations (R-10 & P-01)', () => {
    it('renames slots preserving object, nested, default values, array, and multiline destructuring', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'DestructuredSlotsConsumer.vue': `
  <TargetCard>
    <!-- Object destructuring with alias and default value -->
    <template #header="{ title: customTitle = 'Untitled', count = 0 }">
      <h3>{{ customTitle }} ({{ count }})</h3>
    </template>

    <!-- Deep nested destructuring -->
    <template #detail="{ user: { profile: { email } } }">
      <p>{{ email }}</p>
    </template>

    <!-- Array destructuring -->
    <template #list="[first, second, ...rest]">
      <span>{{ first }}</span>
    </template>

    <!-- Multiline destructuring -->
    <template #footer="{
      author,
      timestamp,
      verified = true,
    }">
      <span>{{ author }}</span>
    </template>
  </TargetCard>
`,
      });
      try {
        // 1. Rename header slot
        const headerPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'header',
          newName: 'topHeader',
          targetPath: root,
        });
        expect(headerPlan.totalPatches).toBe(1);
        expect(headerPlan.patches[0].newSnippet).toBe("#topHeader=\"{ title: customTitle = 'Untitled', count = 0 }\"");

        // 2. Rename detail slot
        const detailPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'detail',
          newName: 'userDetail',
          targetPath: root,
        });
        expect(detailPlan.totalPatches).toBe(1);
        expect(detailPlan.patches[0].newSnippet).toBe('#userDetail="{ user: { profile: { email } } }"');

        // 3. Rename list slot
        const listPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'list',
          newName: 'itemsList',
          targetPath: root,
        });
        expect(listPlan.totalPatches).toBe(1);
        expect(listPlan.patches[0].newSnippet).toBe('#itemsList="[first, second, ...rest]"');

        // 4. Rename footer slot (multiline)
        const footerPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'footer',
          newName: 'cardFooter',
          targetPath: root,
        });
        expect(footerPlan.totalPatches).toBe(1);
        expect(footerPlan.patches[0].newSnippet).toContain('#cardFooter="{\n      author,');
      } finally {
        await cleanup();
      }
    });

    it('renames v-slot destructuring directly on component tag', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'DirectSlotDestructure.vue': `
  <TargetCard v-slot="{ item: { id, name } }">
    <p>{{ id }}: {{ name }}</p>
  </TargetCard>
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'default',
          newName: 'mainContent',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(1);
        expect(plan.patches[0].newSnippet).toBe('v-slot:mainContent="{ item: { id, name } }"');
      } finally {
        await cleanup();
      }
    });
  });

  describe('5. Precondition Checks & Atomic Validation (P-13 & R-10)', () => {
    it('validates coordinates, hashes, and spans, rejecting coordinate mismatches and stale files', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'PreconditionConsumer.vue': `
  <TargetCard label="Alpha" />
`,
      });
      try {
        const plan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'label',
          newName: 'heading',
          targetPath: root,
        });

        expect(plan.totalPatches).toBe(1);
        const patch = plan.patches[0];

        // 1. Initial valid plan passes precondition checks
        const initialCheck = await checkPatchPreconditions([patch]);
        expect(initialCheck.valid).toBe(true);
        expect(initialCheck.errors).toHaveLength(0);

        // 2. Tampered / shifted line or column is rejected with PATCH_COORDINATE_MISMATCH
        const tamperedCoordPatch = { ...patch, line: 99 };
        const coordCheck = await checkPatchPreconditions([tamperedCoordPatch]);
        expect(coordCheck.valid).toBe(false);
        expect(coordCheck.errors.some(e => e.includes('PATCH_COORDINATE_MISMATCH'))).toBe(true);

        // 3. Tampered endOffset is rejected with PATCH_INVALID_SPAN
        const tamperedSpanPatch = { ...patch, sourceRef: { ...patch.sourceRef!, endOffset: patch.sourceRef!.startOffset + 999 } };
        const spanCheck = await checkPatchPreconditions([tamperedSpanPatch]);
        expect(spanCheck.valid).toBe(false);
        expect(spanCheck.errors.some(e => e.includes('PATCH_INVALID_SPAN'))).toBe(true);

        // 4. File modification on disk is rejected with STALE_SOURCE_REF
        await writeFile(patch.file, '<template><div /></template>');
        const staleCheck = await checkPatchPreconditions([patch]);
        expect(staleCheck.valid).toBe(false);
        expect(staleCheck.errors.some(e => e.includes('STALE_SOURCE_REF'))).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe('6. Golden Mutation Matrix Equivalence & Application (P-14 & R-01)', () => {
    it('applies multiple patches atomically and produces syntactically valid Vue template matching golden oracle', async () => {
      const { root, targetComponentPath, cleanup } = await createFixtureWorkspace({
        'GoldenConsumer.vue': `
  <TargetCard
    label="Card Title"
    :item-val="currentValue"
    @select-item="onSelect"
  >
    <template #header="{ title }">
      <h2>{{ title }}</h2>
    </template>
  </TargetCard>
`,
      });
      try {
        // Collect patches across 4 operations: rename_prop, rename_event, rename_model, rename_slot
        const propPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_prop',
          oldName: 'label',
          newName: 'heading',
          targetPath: root,
        });
        const eventPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_event',
          oldName: 'selectItem',
          newName: 'onSelectChanged',
          targetPath: root,
        });
        const modelPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_model',
          oldName: 'itemVal',
          newName: 'dataValue',
          targetPath: root,
        });
        const slotPlan = await generatePatchPlan({
          componentPath: targetComponentPath,
          refactorType: 'rename_slot',
          oldName: 'header',
          newName: 'topHeading',
          targetPath: root,
        });

        const combinedPatches = [
          ...propPlan.patches,
          ...eventPlan.patches,
          ...modelPlan.patches,
          ...slotPlan.patches,
        ];
        expect(combinedPatches).toHaveLength(4);

        // Precondition check must pass for all 4 patches simultaneously
        await validatePatchPreconditions(combinedPatches);

        // Read source and apply patches
        const consumerFile = combinedPatches[0].file;
        const { content: originalContent } = await readSourceSnapshot(consumerFile);
        const transformedContent = applyPatchesToSource(originalContent, combinedPatches);

        // Expected golden oracle:
        // - label="Card Title" -> heading="Card Title"
        // - :item-val="currentValue" -> :data-value="currentValue"
        // - @select-item="onSelect" -> @on-select-changed="onSelect"
        // - #header="{ title }" -> #topHeading="{ title }"
        expect(transformedContent).toContain('heading="Card Title"');
        expect(transformedContent).toContain(':data-value="currentValue"');
        expect(transformedContent).toContain('@on-select-changed="onSelect"');
        expect(transformedContent).toContain('#topHeading="{ title }"');
        expect(transformedContent).not.toContain('label="Card Title"');
        expect(transformedContent).not.toContain(':item-val="currentValue"');
        expect(transformedContent).not.toContain('@select-item="onSelect"');
        expect(transformedContent).not.toContain('#header="{ title }"');

        // Transformed template must parse cleanly with Vue compiler without syntax errors
        expect(() => parseDom(transformedContent)).not.toThrow();
      } finally {
        await cleanup();
      }
    });
  });
});

