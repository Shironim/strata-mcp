import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { extractStyleTokens } from '../../src/engine/contract';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');
const PATCH_FIXTURES_DIR = join(import.meta.dir, '../mock-projects/patch-fixtures');

describe('Patch Plan Engine — Automated Refactoring Plans', () => {
  it('generates patch plan for rename_prop on upward consumers', async () => {
    const componentPath = join(FIXTURES_DIR, 'NewButton.vue');
    const result = await generatePatchPlan({
      componentPath,
      refactorType: 'rename_prop',
      oldName: 'variant',
      newName: 'colorTheme',
      targetPath: FIXTURES_DIR,
    });

    expect(result.component).toBe(componentPath);
    expect(result.refactorType).toBe('rename_prop');
    expect(result.oldName).toBe('variant');
    expect(result.newName).toBe('colorTheme');
    expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
    expect(result.coverage.candidateCount).toBe(result.coverage.analyzedCount + result.coverage.failedCount + result.coverage.unsupportedCount);
    expect(result.coverage.analyzedCount).toBe(result.coverage.analyzedWithPatchCount + result.coverage.analyzedWithoutPatchCount);
    expect(result.totalConsumersAudited).toBe(result.coverage.analyzedCount);
    expect(result.coverage.discovery).toBe('graph-bounded');
    expect(result.totalPatches).toBeGreaterThanOrEqual(1);

    const patch = result.patches.find((p) => p.file.includes('PageThree.vue'));
    expect(patch).toBeDefined();
    expect(patch?.oldSnippet).toBe('variant="success"');
    expect(patch?.newSnippet).toBe('colorTheme="success"');
    expect(patch?.targetTag).toBe('NewButton');
  });

  it('generates patch plan for remove_prop on upward consumers', async () => {
    const componentPath = join(FIXTURES_DIR, 'NewButton.vue');
    const result = await generatePatchPlan({
      componentPath,
      refactorType: 'remove_prop',
      oldName: 'variant',
      targetPath: FIXTURES_DIR,
    });

    expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
    expect(result.totalPatches).toBeGreaterThanOrEqual(1);

    const patch = result.patches.find((p) => p.file.includes('PageThree.vue'));
    expect(patch).toBeDefined();
    expect(patch?.newSnippet).toBe('');
  });

  it('generates patch plan for rename_model on upward consumers', async () => {
    const componentPath = join(PATCH_FIXTURES_DIR, 'ModalCard.vue');
    const result = await generatePatchPlan({
      componentPath,
      refactorType: 'rename_model',
      oldName: 'show',
      newName: 'visible',
      targetPath: PATCH_FIXTURES_DIR,
    });

    expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
    expect(result.totalPatches).toBeGreaterThanOrEqual(1);

    const patch = result.patches.find((p) => p.file.includes('ModalConsumer.vue'));
    expect(patch).toBeDefined();
    expect(patch?.oldSnippet).toBe('v-model:show="isModalActive"');
    expect(patch?.newSnippet).toBe('v-model:visible="isModalActive"');
  });

  it('generates patch plan for rename_slot on upward consumers', async () => {
    const componentPath = join(PATCH_FIXTURES_DIR, 'ModalCard.vue');
    const result = await generatePatchPlan({
      componentPath,
      refactorType: 'rename_slot',
      oldName: 'header',
      newName: 'topHeader',
      targetPath: PATCH_FIXTURES_DIR,
    });

    expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
    expect(result.totalPatches).toBeGreaterThanOrEqual(1);

    const patch = result.patches.find((p) => p.file.includes('ModalConsumer.vue'));
    expect(patch).toBeDefined();
    expect(patch?.oldSnippet).toContain('#header');
    expect(patch?.newSnippet).toContain('#topHeader');
  });

  it('detects layout clashes (fixed combined with transform/backdrop) in style tokens', () => {
    const templateWithClash = `
      <template>
        <div class="fixed inset-0 transform scale-100 backdrop-blur-md">
          <h1>Clash Modal</h1>
        </div>
      </template>
    `;
    const tokens = extractStyleTokens(templateWithClash);
    expect(tokens).toBeDefined();
    expect(tokens?.layoutTraps).toContain('layout-clash:fixed-in-transform-stacking-context');
    expect(tokens?.layoutTraps).toContain('transform');
    expect(tokens?.positioning).toContain('fixed');
  });

  it('normalizes prop/event directives with shorthand prefixes and kebab/camel case (Issue #1)', async () => {
    const { cleanIdentifier, matchVueProp, matchVueEvent } = await import('../../src/engine/patch-plan');

    // Prop matching across conventions and prefixes
    expect(matchVueProp(':sort-by', 'sortBy')).toBe(true);
    expect(matchVueProp('v-bind:sort-by', 'sortBy')).toBe(true);
    expect(matchVueProp('sort-by', 'sortBy')).toBe(true);
    expect(matchVueProp('sortBy', 'sort-by')).toBe(true);
    expect(cleanIdentifier(':sort-by')).toBe('sort-by');
    expect(cleanIdentifier('@sort')).toBe('sort');
    expect(cleanIdentifier('v-on:sort')).toBe('sort');

    // Event matching across conventions and prefixes
    expect(matchVueEvent('@sort', 'sort')).toBe(true);
    expect(matchVueEvent('v-on:sort', 'sort')).toBe(true);
    expect(matchVueEvent('sort', 'sort')).toBe(true);
    expect(matchVueEvent('item-selected', 'itemSelected')).toBe(true);
  });

  it('generates patch plan for rename_prop and detects dynamic spread omissions on TSX consumers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-patch-tsx-'));
    try {
      const btnPath = join(root, 'Button.tsx');
      const pagePath = join(root, 'Page.tsx');
      await writeFile(btnPath, 'export interface ButtonProps { color: string; }\nexport const Button = (props: ButtonProps) => <button />;');
      await writeFile(
        pagePath,
        `import { Button } from './Button';
export const Page = (extra: any) => {
  return (
    <div>
      <Button color="blue" />
      <Button {...extra} />
    </div>
  );
};`
      );

      const result = await generatePatchPlan({
        componentPath: btnPath,
        refactorType: 'rename_prop',
        oldName: 'color',
        newName: 'themeColor',
        targetPath: root,
      });

      expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
      expect(result.totalPatches).toBe(1);
      expect(result.patches[0]?.file).toBe(pagePath);
      expect(result.patches[0]?.oldSnippet).toBe('color');
      expect(result.patches[0]?.newSnippet).toBe('themeColor');

      const omissions = result.coverage.omissions.filter((o) => o.code === 'DYNAMIC_PROP_SPREAD');
      expect(omissions.length).toBeGreaterThanOrEqual(1);
      expect(omissions[0]?.file).toBe(pagePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('generates patch plan for rename_prop on Svelte consumers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-patch-svelte-'));
    try {
      const btnPath = join(root, 'Button.svelte');
      const pagePath = join(root, 'Page.svelte');
      await writeFile(btnPath, '<script>export let color = "red";</script><button>{color}</button>');
      await writeFile(
        pagePath,
        `<script>import Button from './Button.svelte';</script>
<Button color="blue" />`
      );

      const result = await generatePatchPlan({
        componentPath: btnPath,
        refactorType: 'rename_prop',
        oldName: 'color',
        newName: 'themeColor',
        targetPath: root,
      });

      expect(result.totalConsumersAudited).toBeGreaterThanOrEqual(1);
      expect(result.totalPatches).toBe(1);
      expect(result.patches[0]?.file).toBe(pagePath);
      expect(result.patches[0]?.oldSnippet).toBe('color');
      expect(result.patches[0]?.newSnippet).toBe('themeColor');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles missing file in inspect_component tool without double path concatenation (Issue #2)', async () => {
    const { inspectComponentTool } = await import('../../src/tools/inspect-component');
    const res = await inspectComponentTool.handler({
      path: '/home/shironim/Project/toko-km/resources/js/Pages/NonExistent.vue',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Component file not found: /home/shironim/Project/toko-km/resources/js/Pages/NonExistent.vue');
    expect(res.content[0].text).not.toContain('/home/shironim/Project/toko-km/home/shironim/Project/toko-km');
  });
});
