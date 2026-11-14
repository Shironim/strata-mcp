import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/storage/schema';
import { patchPlanTool } from '../../src/tools/patch-plan';
import { componentTreeTool } from '../../src/tools/component-tree';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { getComponentTree } from '../../src/engine/tree';
import { traceStateTool } from '../../src/tools/trace-state';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { findCodeTool } from '../../src/tools/find-code';
import { withAnalysisContext } from '../../src/engine/analysis-context';

let root = '';
afterEach(async () => { closeAllDatabases(); if (root) await rm(root, { recursive: true, force: true }); root = ''; });
const child = '<script setup lang="ts">defineProps<{title:string}>()</script><template><div/></template>';
const parent = '<script setup>import Child from "./Child.vue";</script><template><Child title="hello"/></template>';
async function fixture() {
  root = await mkdtemp('/tmp/strata-consistency-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  getWorkspaceDatabase(root, { create: true });
}

test('scope fallback publishes independent edits, additions and deletions outside the requested scope', async () => {
  await fixture(); await mkdir(join(root, 'a')); await mkdir(join(root, 'b'));
  await writeFile(join(root, 'a/A.vue'), child); await writeFile(join(root, 'b/B.vue'), child);
  await writeFile(join(root, 'b/Deleted.vue'), child); await syncWorkspace(root);
  const updated = child.replace('title:string', 'heading:string');
  await writeFile(join(root, 'a/A.vue'), updated); await writeFile(join(root, 'b/B.vue'), updated);
  await writeFile(join(root, 'b/Added.vue'), updated); await rm(join(root, 'b/Deleted.vue'));
  const result = await syncWorkspace(root, 'a');
  expect(result.scope?.effective).toBe(root);
  expect(result.parserInvocations).toBe(3);
  const graph = () => getWorkspaceDatabase(root).query('SELECT path, content_hash FROM files ORDER BY path').all();
  const incremental = graph();
  const hash = createHash('sha256').update(updated).digest('hex');
  expect(incremental).toEqual(['a/A.vue', 'b/Added.vue', 'b/B.vue'].map(path => ({ path: join(root, path), content_hash: hash })));
  await syncWorkspace(root, undefined, undefined, { rebuild: true });
  expect(graph()).toEqual(incremental);
});

test('unchanged sync retains snapshot generation; route changes replace it', async () => {
  await fixture(); await mkdir(join(root, 'src/views'), { recursive: true });
  await writeFile(join(root, 'src/views/Home.vue'), child);
  const first = await syncWorkspace(root);
  const warm = await syncWorkspace(root);
  expect(warm.syncGeneration).toBe(first.syncGeneration);
  expect(warm.cacheHit).toBe(true);
  await writeFile(join(root, 'src/views/About.vue'), child);
  expect((await syncWorkspace(root)).syncGeneration).toBeGreaterThan(first.syncGeneration);
});

test('patch plans discover consumers added since the last sync through tool and library entrypoints', async () => {
  await fixture(); await writeFile(join(root, 'Child.vue'), child); await writeFile(join(root, 'A.vue'), parent);
  await syncWorkspace(root); await writeFile(join(root, 'B.vue'), parent);
  const result = await patchPlanTool.handler({ path: join(root, 'Child.vue'), target_path: root,
    refactor_type: 'rename_prop', old_name: 'title', new_name: 'heading', format: 'json', max_bytes: 50000 });
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent?.patches as any[]).map(p => basename(p.file))).toEqual(['A.vue', 'B.vue']);
  expect(result.structuredContent?.patchValidation).toMatchObject({ valid: true, validatedPatchCount: 2 });
  await writeFile(join(root, 'C.vue'), parent);
  const plan = await generatePatchPlan({ componentPath: join(root, 'Child.vue'), targetPath: root,
    refactorType: 'rename_prop', oldName: 'title', newName: 'heading' });
  expect(plan.patches.map(p => basename(p.file))).toEqual(['A.vue', 'B.vue', 'C.vue']);
});

test('tree continuation survives unchanged preflight and rejects changed inputs', async () => {
  await fixture(); await writeFile(join(root, 'Child.vue'), child);
  for (let i = 0; i < 35; i++) await writeFile(join(root, `Parent${i}.vue`), parent);
  await syncWorkspace(root);
  const args = { path: join(root, 'Child.vue'), target_path: root, direction: 'upward', max_depth: 3,
    limit: 100, format: 'json', max_bytes: 12000 };
  const first = await componentTreeTool.handler(args);
  const token = first.structuredContent?.continuationToken;
  expect(token).toBeString();
  const second = await componentTreeTool.handler({ ...args, continuation_token: token });
  expect(second.isError).not.toBe(true);
  expect(second.structuredContent?.offset).toBe(first.structuredContent?.nextOffset);
  await writeFile(join(root, 'Another.vue'), parent);
  const stale = await componentTreeTool.handler({ ...args, continuation_token: token });
  expect(stale.isError).toBe(true);
  expect(stale.content[0].text).toContain('STALE_CONTINUATION_TOKEN');
});

test('direct upward tree refreshes an existing index before consumer discovery', async () => {
  await fixture(); await writeFile(join(root, 'Child.vue'), child); await writeFile(join(root, 'A.vue'), parent);
  await syncWorkspace(root); await writeFile(join(root, 'B.vue'), parent);
  const tree = await getComponentTree({ entryPath: join(root, 'Child.vue'), targetPath: root, direction: 'upward' });
  expect(tree.root.children?.map(node => basename(node.filePath))).toEqual(['A.vue', 'B.vue']);
});

test('indexed state tools report failed refresh instead of returning cached results', async () => {
  await fixture(); await writeFile(join(root, 'App.vue'), parent); await syncWorkspace(root);
  await writeFile(join(root, 'App.vue'), '<template><div></template>');
  const trace = await traceStateTool.handler({ path: root, identifier: 'useCartStore', format: 'json' });
  expect(trace.isError).toBe(true);
  expect(trace.content[0].text).toContain('PARSE_FAILED');
  const audit = await auditFrontendTool.handler({ path: root, target: 'dead-state', format: 'json' });
  expect(audit.isError).toBe(true);
  expect(audit.content[0].text).toContain('PARSE_FAILED');
});

test('canonical and alias requests share the same snippet query identity', async () => {
  const canonical = await findCodeTool.handler({ code: 'ref(1)', pattern: 'ref($$$)', format: 'json' });
  const alias = await findCodeTool.handler({ code_snippet: 'ref(1)', query: 'ref($$$)', outputFormat: 'json' });
  expect(canonical.isError).not.toBe(true);
  expect(alias.structuredContent?.matches).toEqual(canonical.structuredContent?.matches);
  expect((alias.structuredContent?.retrieval as any).queryId).toBe((canonical.structuredContent?.retrieval as any).queryId);
});

test('cancelled sync leaves the previously published graph and generation intact', async () => {
  await fixture(); await writeFile(join(root, 'Child.vue'), child); await syncWorkspace(root);
  const db = getWorkspaceDatabase(root);
  const before = db.query('SELECT path, content_hash FROM files').all();
  const generation = db.query("SELECT value FROM meta WHERE key='sync_generation'").get();
  await writeFile(join(root, 'Child.vue'), child.replace('title:string', 'heading:string'));
  const controller = new AbortController();
  const pending = withAnalysisContext(() => syncWorkspace(root), controller.signal);
  controller.abort(new Error('REQUEST_CANCELLED: test'));
  await expect(pending).rejects.toThrow('REQUEST_CANCELLED');
  expect(db.query('SELECT path, content_hash FROM files').all()).toEqual(before);
  expect(db.query("SELECT value FROM meta WHERE key='sync_generation'").get()).toEqual(generation);
});
