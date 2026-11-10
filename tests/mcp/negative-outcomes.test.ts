import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { TOOLS } from '../../src/tools';

test('real Vue handlers report bounded negative results with operation-specific selections', async () => {
  const root = await mkdtemp('/tmp/strata-negative-outcomes-');
  try {
    const path = join(root, 'Child.vue');
    await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
    await writeFile(path, '<script setup lang="ts">defineProps<{ title: string }>();</script><template><h1>{{ title }}</h1></template>');
    getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    await syncWorkspace(root);
    const requests: Array<[string, Record<string, unknown>, string, string]> = [
      ['find_code', { path: root, mode: 'literal', pattern: 'ABSENT_SENTINEL_8c023' }, 'search-matches', 'literal'],
      ['inspect_component', { path, project_root: root, symbol: 'ABSENT_SENTINEL_8c023' }, 'selected-symbol', 'symbol'],
      ['get_component_tree', { path, target_path: root, direction: 'upward' }, 'direct-consumer-candidates', 'upward'],
      ['trace_state', { path: root, identifier: 'useAbsentSentinel8c023' }, 'state-consumers', 'impact'],
      ['audit_frontend', { path: root, target: 'routes' }, 'audit-routes', 'routes'],
      ['generate_patch_plan', { path, target_path: root, refactor_type: 'rename_prop', old_name: 'title', new_name: 'heading' }, 'proposed-static-edits', 'rename_prop'],
    ];
    for (const [name, args, subject, operation] of requests) {
      for (const format of ['json', 'text']) {
        const result = await TOOLS.find(tool => tool.name === name)!.handler({ ...args, format });
        expect(result.isError).not.toBe(true);
        const decision = result.structuredContent?.decision as any;
        expect(decision).toMatchObject({ status: 'partial', emptyOutcome: 'inconclusive', selection: { subject, count: 0 }, capability: { operation, implementation: 'declared' } });
        const block = result.content.find(item => {
          if (item.text.startsWith('Decision:')) return true;
          try { return Boolean(JSON.parse(item.text).decision); } catch { return false; }
        });
        expect(block).toBeDefined();
        if (block!.text.startsWith('Decision:')) {
          expect(block!.text).toContain(`Selection: ${subject}; count=0`);
          expect(block!.text).toContain('empty=inconclusive');
        } else expect(JSON.parse(block!.text).decision).toMatchObject({
          status: decision.status, emptyOutcome: decision.emptyOutcome, selection: decision.selection,
        });
      }
    }
    const all = await TOOLS.find(tool => tool.name === 'audit_frontend')!.handler({ path: root, target: 'all', format: 'json' });
    expect(all.isError).not.toBe(true);
    const decision = all.structuredContent?.decision as any;
    expect(decision.selection.subject).toBe('audit-all');
    // Child is a standalone component without a rendered consumer: a positive control.
    expect(decision.selection.count).toBeGreaterThan(0);
    expect(decision.emptyOutcome).toBe('not-asserted');
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('unresolved Vue render references stay visible rather than becoming complete empty results', async () => {
  const root = await mkdtemp('/tmp/strata-negative-unresolved-');
  try {
    const path = join(root, 'App.vue');
    await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
    await writeFile(path, '<script setup>import Missing from "./Missing.vue";</script><template><Missing /></template>');
    getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    await syncWorkspace(root);
    const result = await TOOLS.find(tool => tool.name === 'get_component_tree')!.handler({ path, target_path: root, format: 'json' });
    const decision = result.structuredContent?.decision as any;
    expect(result.isError).not.toBe(true);
    expect(decision.status).toBe('partial');
    expect(decision.emptyOutcome).not.toBe('none-in-checked-scope');
    expect((result.structuredContent?.retrieval as any).omissions.some((item: any) => item.code === 'UNRESOLVED_RENDERED_IMPORT')).toBe(true);
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});
