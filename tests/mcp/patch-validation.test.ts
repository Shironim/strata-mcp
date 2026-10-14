import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { clearLastKnownProjectRoot } from '../../src/engine/path-resolver';
import { createMcpServer } from '../../src/mcp';
import { patchPlanTool } from '../../src/tools/patch-plan';
import type { PatchRefactorType } from '../../src/types';

describe('patch plan runtime validation', () => {
  let root: string;
  let componentPath: string;
  beforeEach(() => {
    clearLastKnownProjectRoot();
    root = mkdtempSync('/tmp/strata-patch-validation-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{}');
    componentPath = join(root, 'src/Button.vue');
    writeFileSync(componentPath, '<template><button/></template>');
    writeFileSync(join(root, 'src/App.tsx'), 'import Button from "./Button.vue"; export default function App(){return <Button label="Hi"/>}');
    writeFileSync(join(root, 'src/Page.vue'), '<script setup>import Button from "./Button.vue";</script><template><Button label="Hi"/></template>');
  });
  afterEach(() => {
    clearLastKnownProjectRoot();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects invalid library operations instead of recommending JSX deletion', async () => {
    await expect(generatePatchPlan({ componentPath, refactorType: 'not_valid' as PatchRefactorType, oldName: 'label' }))
      .rejects.toThrow(/Invalid refactor_type/);
  });

  it('rejects invalid operations before resolving a missing component', async () => {
    await expect(generatePatchPlan({ componentPath: join(root, 'missing.vue'), refactorType: 'rename_typo' as PatchRefactorType, oldName: 'label', newName: 'title' }))
      .rejects.toThrow(/Invalid refactor_type/);
    expect(existsSync(join(root, '.strata'))).toBe(false);
  });

  for (const operation of [undefined, null, 42, {}, 'rename_typo', 'not_valid']) {
    it(`returns an MCP handler error for invalid operation ${JSON.stringify(operation)}`, async () => {
      const result = await patchPlanTool.handler({ path: componentPath, target_path: root, refactor_type: operation, old_name: 'label', new_name: 'title', format: 'json' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid refactor_type/);
      expect(result.content[0].text).not.toContain('"patches"');
    });
  }

  it('rejects invalid operations through MCP dispatch and its analysis worker', async () => {
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      const result = await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: {
        path: componentPath, target_path: root, refactor_type: 'not_valid', old_name: 'label', format: 'json',
      } } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid refactor_type/);
      expect(result.content[0].text).not.toContain('"patches"');
    } finally { await server.close(); }
  });

  for (const flag of ['--refactor', '--refactor-type']) {
    it(`exits nonzero without a patch for CLI ${flag} not_valid`, () => {
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../src/mcp.ts'), 'patch-plan', componentPath, flag, 'not_valid', '--old', 'label', '--json'], { cwd: root });
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toMatch(/Invalid refactor_type/);
      expect(proc.stdout.toString()).toBe('');
    });
  }

  for (const refactorType of ['rename_prop', 'rename_event', 'rename_model', 'rename_slot'] as const) {
    it(`rejects ${refactorType} without a replacement at the library boundary`, async () => {
      await expect(generatePatchPlan({ componentPath, refactorType, oldName: 'label' })).rejects.toThrow(/new_name/);
    });
  }

  it('rejects an empty normalized old name at the library boundary', async () => {
    await expect(generatePatchPlan({ componentPath, refactorType: 'remove_prop', oldName: ' : ' })).rejects.toThrow(/old_name/);
  });

  it('rejects a whitespace replacement at the library boundary', async () => {
    await expect(generatePatchPlan({ componentPath, refactorType: 'rename_prop', oldName: 'label', newName: ' ' })).rejects.toThrow(/new_name/);
  });

  for (const refactorType of ['rename_prop', 'remove_prop'] as const) {
    it(`preserves ${refactorType} through MCP dispatch and CLI`, async () => {
      const server = createMcpServer();
      try {
        const call = (server as any)._requestHandlers.get('tools/call');
        const response = await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: {
          path: componentPath, target_path: root, refactor_type: refactorType, old_name: 'label', new_name: 'title', format: 'json',
        } } });
        expect(response.isError).toBeFalsy();
        const data = JSON.parse(response.content[0].text);
        expect(data.totalPatches).toBe(2);
        expect(data.patches.find((p: any) => p.file.endsWith('App.tsx')).newSnippet).toBe(refactorType === 'rename_prop' ? 'title' : '');
        const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../src/mcp.ts'), 'patch-plan', componentPath, '--refactor', refactorType, '--old', 'label', '--new', 'title', '--json'], { cwd: root });
        expect(proc.exitCode).toBe(0);
        expect(JSON.parse(proc.stdout.toString()).patches).toEqual(data.patches);
      } finally { await server.close(); }
    });

    it(`preserves ${refactorType} patches in Vue and TSX`, async () => {
      const result = await generatePatchPlan({ componentPath, refactorType, oldName: 'label', newName: refactorType === 'rename_prop' ? 'title' : undefined });
      expect(result.totalConsumersAudited).toBe(2);
      expect(result.totalPatches).toBe(2);
      const jsx = result.patches.find(p => p.file.endsWith('App.tsx'))!;
      const vue = result.patches.find(p => p.file.endsWith('Page.vue'))!;
      expect(jsx.oldSnippet).toBe(refactorType === 'rename_prop' ? 'label' : 'label="Hi"');
      expect(jsx.newSnippet).toBe(refactorType === 'rename_prop' ? 'title' : '');
      expect(vue.oldSnippet).toBe('label="Hi"');
      expect(vue.newSnippet).toBe(refactorType === 'rename_prop' ? 'title="Hi"' : '');
    });
  }

  for (const [refactorType, oldName, newName, expected] of [
    ['rename_event', 'click', 'submit', '@submit="handle"'],
    ['remove_event', 'click', undefined, ''],
    ['rename_model', 'open', 'visible', 'v-model:visible="open"'],
    ['remove_model', 'open', undefined, ''],
    ['rename_slot', 'header', 'title', '#title'],
    ['remove_slot', 'header', undefined, ''],
  ] as const) {
    it(`preserves supported Vue operation ${refactorType}`, async () => {
      writeFileSync(join(root, 'src/Page.vue'), '<script setup>import Button from "./Button.vue";</script><template><Button @click="handle" v-model:open="open"><template #header>Hi</template></Button></template>');
      const plan = await generatePatchPlan({ componentPath, refactorType, oldName, newName });
      expect(plan.totalPatches).toBe(1);
      expect(plan.patches[0].file).toBe(join(root, 'src/Page.vue'));
      expect(plan.patches[0].newSnippet).toBe(expected);
    });
  }
});
