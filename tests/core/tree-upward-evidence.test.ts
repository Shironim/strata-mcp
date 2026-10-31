import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getComponentTree, formatTreeAsText } from '../../src/engine/tree';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { componentTreeTool } from '../../src/tools/component-tree';

let root = '';
afterEach(async () => {
  closeAllDatabases();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function fixture() {
  root = await mkdtemp('/tmp/strata-upward-evidence-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await mkdir(join(root, 'local'));
  const entryPath = join(root, 'local', 'Leaf.vue');
  await writeFile(entryPath, '<template><div/></template>');
  await writeFile(join(root, 'Parent.vue'), '<script setup>import Leaf from "./local/Leaf.vue";</script><template><Leaf/></template>');
  await writeFile(join(root, 'App.vue'), '<script setup>import Parent from "./Parent.vue";</script><template><Parent/></template>');
  return { entryPath, targetPath: root, direction: 'upward' as const };
}

test('Vue upward reports depth and scope boundaries without losing discovered consumer nodes', async () => {
  const options = await fixture();
  const bounded = await getComponentTree({ ...options, maxDepth: 1 });
  expect(bounded.root.children.map(node => node.filePath)).toEqual([join(root, 'Parent.vue')]);
  expect(bounded.root.children[0].children).toEqual([]);
  expect(bounded.diagnostics).toHaveLength(1);
  expect(bounded.diagnostics![0]).toMatchObject({ code: 'MAX_DEPTH_REACHED', filePath: join(root, 'Parent.vue'), depth: 1, sourceHash: null });
  const scoped = await getComponentTree({ ...options, scopeFilter: join(root, 'local') });
  expect(scoped.root.children[0]).toMatchObject({ filePath: join(root, 'Parent.vue'), isExternalScope: true, children: [] });
  expect(scoped.diagnostics![0]).toMatchObject({ code: 'SCOPE_BOUNDARY', filePath: join(root, 'Parent.vue'), depth: 1 });
  const expanded = await getComponentTree({ ...options, maxDepth: 4 });
  expect(expanded.root.children[0].children[0].filePath).toBe(join(root, 'App.vue'));
  expect(expanded.totalComponents).toBe(3);
  expect(expanded.diagnostics).toEqual([]);
});

test('Vue upward exposes discovery read and parse exclusions independently of proven consumer relation', async () => {
  const options = await fixture();
  const broken = '<template><Broken></template>';
  await writeFile(join(root, 'Broken.vue'), broken);
  await writeFile(join(root, 'Oversized.vue'), '');
  await truncate(join(root, 'Oversized.vue'), 8 * 1024 * 1024 + 1);
  const result = await getComponentTree(options);
  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics![0]).toMatchObject({ code: 'CONSUMER_INPUT_UNSUPPORTED', filePath: join(root, 'Broken.vue'),
    sourceHash: createHash('sha256').update(broken).digest('hex') });
  expect(result.diagnostics![1]).toMatchObject({ code: 'CONSUMER_SOURCE_READ_FAILED', filePath: join(root, 'Oversized.vue'), sourceHash: null });
  expect(result.diagnostics![1].reason).toContain('SOURCE_TOO_LARGE');
  expect(result.diagnostics!.every(item => !('depth' in item))).toBe(true);
  expect(result.totalComponents).toBe(3);
  expect(formatTreeAsText(result)).toContain('CONSUMER_SOURCE_READ_FAILED');
});

test('Vue upward cycle retains closing node and forwards omission through handler', async () => {
  const options = await fixture();
  const source = '<script setup>import Parent from "../Parent.vue";</script><template><Parent/></template>';
  await writeFile(options.entryPath, source);
  const result = await getComponentTree({ ...options, maxDepth: 10 });
  const parent = result.root.children.find(node => node.filePath === join(root, 'Parent.vue'))!;
  const closing = parent.children.find(node => node.filePath === options.entryPath)!;
  expect(closing).toMatchObject({ isCircular: true, depth: 2, children: [] });
  expect(result.totalComponents).toBe(3);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics![0]).toMatchObject({ code: 'CYCLE_TRUNCATED', filePath: options.entryPath,
    targetPath: options.entryPath, depth: 2, sourceHash: createHash('sha256').update(source).digest('hex') });
  expect(await getComponentTree({ ...options, maxDepth: 10 })).toEqual(result);
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  const response = await componentTreeTool.handler({ path: options.entryPath, target_path: root, direction: 'upward', max_depth: 10, format: 'json' });
  expect(response.isError).not.toBe(true);
  const payload = JSON.parse(response.content[0].text);
  expect(payload.retrieval.omissions.some((item: { code: string }) => item.code === 'CYCLE_TRUNCATED')).toBe(true);
  expect(payload.retrieval.completeness).toBe('partial');
});

test('Vue upward shared consumer in sibling branches is not a cycle', async () => {
  const options = await fixture();
  await writeFile(join(root, 'Other.vue'), '<script setup>import Leaf from "./local/Leaf.vue";</script><template><Leaf/></template>');
  await writeFile(join(root, 'App.vue'), '<script setup>import Parent from "./Parent.vue"; import Other from "./Other.vue";</script><template><Parent/><Other/></template>');
  const result = await getComponentTree({ ...options, maxDepth: 4 });
  expect(result.totalComponents).toBe(4);
  expect(result.root.children).toHaveLength(2);
  expect(result.root.children.every(node => node.children[0].filePath === join(root, 'App.vue') && !node.children[0].isCircular)).toBe(true);
  expect(result.diagnostics).toEqual([]);
});
