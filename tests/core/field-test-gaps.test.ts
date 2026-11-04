import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodeTool } from '../../src/tools/find-code';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { generatePatchPlan } from '../../src/engine/patch-plan';

describe('Sub-Fase 1.1: Field Test Gap Closure (TODO-04A s/d TODO-04D)', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'strata-gaps-'));
    // Setup sample files
    await writeFile(
      join(tempDir, 'Sample.vue'),
      `<script setup lang="ts">
const message = 'hello world';
console.log(message);
</script>
<template>
  <div class="sample">
    <span>{{ message }}</span>
  </div>
</template>`
    );

    await writeFile(
      join(tempDir, 'Broken.vue'),
      `<script setup lang="ts">
defineProps<{ id: string }>();
</script>
<template>
  <div><span>unclosed tag
</template>`
    );

    await writeFile(
      join(tempDir, 'Pug.vue'),
      `<script setup lang="ts">
defineProps<{ title: string }>();
</script>
<template lang="pug">
div
  p {{ title }}
</template>`
    );

    await writeFile(
      join(tempDir, 'Toggle.vue'),
      `<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>
<template>
  <button>{{ label }}</button>
</template>`
    );

    await writeFile(
      join(tempDir, 'ToggleConsumer.vue'),
      `<script setup lang="ts">
import Toggle from './Toggle.vue';
import { ref } from 'vue';
const active = ref(false);
</script>
<template>
  <Toggle :model-value="active" @update:model-value="active = $event" label="Status" />
</template>`
    );

    await writeFile(
      join(tempDir, 'Input.vue'),
      `<script setup lang="ts">
defineProps<{ modelValue: string; placeholder?: string }>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>
<template>
  <input :value="modelValue" />
</template>`
    );

    await writeFile(
      join(tempDir, 'InputConsumer.vue'),
      `<script setup lang="ts">
import Input from './Input.vue';
import { ref } from 'vue';
const query = ref('');
</script>
<template>
  <Input v-model="query" placeholder="Type here..." />
</template>`
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('TODO-04A: find_code AST Error Handling & Auto Fallback (F-05 & F-06)', () => {
    it('returns an explicit pattern error on syntactically invalid AST pattern in mode: ast', async () => {
      const result = await findCodeTool.handler({
        path: tempDir,
        pattern: '((',
        mode: 'ast',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid AST pattern');
    });

    it('falls back automatically to literal search on invalid AST pattern in mode: auto', async () => {
      const result = await findCodeTool.handler({
        path: tempDir,
        pattern: '((',
        mode: 'auto',
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.modeUsed).toBe('literal');
      expect(result.structuredContent?.fallbackReason).toBe('invalid_ast_pattern');
    });

    it('does NOT fallback to literal when a valid AST pattern has 0 matches (negative control)', async () => {
      const result = await findCodeTool.handler({
        path: tempDir,
        pattern: 'nonExistentHelper123456789($$$)',
        mode: 'auto',
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.modeUsed).toBe('ast');
      expect(result.structuredContent?.matchCount).toBe(0);
      expect(result.structuredContent?.fallbackReason).toBeUndefined();
    });
  });

  describe('TODO-04B: find_code Truncation & Total Match Signaling (F-09)', () => {
    it('signals truncation with coverage metadata and MAX_RESULTS_TRUNCATED omission when limit is hit', async () => {
      const result = await findCodeTool.handler({
        path: tempDir,
        pattern: 'const',
        mode: 'ast',
        max_results: 1,
        format: 'json',
      });

      expect(result.structuredContent?.coverage?.truncated).toBe(true);
      expect(result.structuredContent?.truncated).toBe(true);
      expect(result.structuredContent?.coverage?.limit).toBe(1);

      const omissions = result.structuredContent?.retrieval?.omissions;
      expect(omissions?.some((o: any) => o.code === 'MAX_RESULTS_TRUNCATED')).toBe(true);
    });

    it('does NOT signal truncation when results are below max_results limit', async () => {
      const result = await findCodeTool.handler({
        path: tempDir,
        pattern: 'nonExistentVarX',
        mode: 'literal',
        max_results: 10,
        format: 'json',
      });

      expect(result.structuredContent?.coverage?.truncated).toBe(false);
      expect(result.structuredContent?.truncated).toBe(false);
      const omissions = result.structuredContent?.retrieval?.omissions;
      expect(omissions?.some((o: any) => o.code === 'MAX_RESULTS_TRUNCATED')).toBe(false);
    });
  });

  describe('TODO-04C: generate_patch_plan v-model Shorthand & Expanded Binding Refactoring (P-01)', () => {
    it('renames expanded :model-value and @update:model-value bindings on rename_model', async () => {
      const plan = await generatePatchPlan({
        componentPath: join(tempDir, 'Toggle.vue'),
        targetPath: tempDir,
        refactorType: 'rename_model',
        oldName: 'modelValue',
        newName: 'checked',
      });

      expect(plan.patches.length).toBe(2);
      const propPatch = plan.patches.find(p => p.oldSnippet.includes(':model-value'));
      expect(propPatch).toBeDefined();
      expect(propPatch!.newSnippet).toContain(':checked="active"');

      const eventPatch = plan.patches.find(p => p.oldSnippet.includes('@update:model-value'));
      expect(eventPatch).toBeDefined();
      expect(eventPatch!.newSnippet).toContain('@update:checked=');
    });

    it('removes expanded :model-value and @update:model-value bindings on remove_model', async () => {
      const plan = await generatePatchPlan({
        componentPath: join(tempDir, 'Toggle.vue'),
        targetPath: tempDir,
        refactorType: 'remove_model',
        oldName: 'modelValue',
      });

      expect(plan.patches.length).toBe(2);
      expect(plan.patches.every(p => p.newSnippet === '')).toBe(true);
    });

    it('renames shorthand v-model directive on rename_model', async () => {
      const plan = await generatePatchPlan({
        componentPath: join(tempDir, 'Input.vue'),
        targetPath: tempDir,
        refactorType: 'rename_model',
        oldName: 'modelValue',
        newName: 'text',
      });

      expect(plan.patches.length).toBe(1);
      expect(plan.patches[0].oldSnippet).toContain('v-model="query"');
      expect(plan.patches[0].newSnippet).toBe('v-model:text="query"');
    });

    it('removes shorthand v-model directive on remove_model', async () => {
      const plan = await generatePatchPlan({
        componentPath: join(tempDir, 'Input.vue'),
        targetPath: tempDir,
        refactorType: 'remove_model',
        oldName: 'modelValue',
      });

      expect(plan.patches.length).toBe(1);
      expect(plan.patches[0].oldSnippet).toContain('v-model="query"');
      expect(plan.patches[0].newSnippet).toBe('');
    });
  });

  describe('TODO-04D: inspect_component Template Structural Validation (I-11)', () => {
    it('surfaces VUE_PARSE_FAILED omission and marks completeness partial on malformed template', async () => {
      const result = await inspectComponentTool.handler({
        path: join(tempDir, 'Broken.vue'),
        format: 'json',
      });

      const retrieval = result.structuredContent?.retrieval;
      expect(retrieval?.completeness).toBe('partial');
      const parseFailed = retrieval?.omissions?.find((o: any) => o.code === 'VUE_PARSE_FAILED');
      expect(parseFailed).toBeDefined();
      expect(parseFailed?.reason).toContain('Element is missing end tag');
    });

    it('surfaces VUE_TEMPLATE_UNSUPPORTED omission on template lang="pug"', async () => {
      const result = await inspectComponentTool.handler({
        path: join(tempDir, 'Pug.vue'),
        format: 'json',
      });

      const retrieval = result.structuredContent?.retrieval;
      expect(retrieval?.completeness).toBe('partial');
      const unsupp = retrieval?.omissions?.find((o: any) => o.code === 'VUE_TEMPLATE_UNSUPPORTED');
      expect(unsupp).toBeDefined();
    });

    it('surfaces VUE_PARSE_FAILED in diagnostics when view: map is requested on broken template', async () => {
      const result = await inspectComponentTool.handler({
        path: join(tempDir, 'Broken.vue'),
        view: 'map',
        format: 'json',
      });

      const diagnostics = result.structuredContent?.diagnostics;
      expect(diagnostics?.some((d: any) => d.code === 'VUE_PARSE_FAILED')).toBe(true);
      expect(result.structuredContent?.retrieval?.completeness).toBe('partial');
    });
  });
});

