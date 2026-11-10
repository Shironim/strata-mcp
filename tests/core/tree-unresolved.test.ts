import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getComponentTree, formatTreeAsText } from '../../src/engine/tree';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { componentTreeTool } from '../../src/tools/component-tree';
import { collectVueDynamicTreeInputs } from '../../src/engine/graph/vue-tree-input';

let root = '';
afterEach(async () => {
  closeAllDatabases();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

test('rendered local unresolved imports are source-bound diagnostics and disappear when resolved', async () => {
  root = await mkdtemp('/tmp/strata-tree-unresolved-');
  await writeFile(join(root, 'package.json'), '{}');
  const source = '<script setup>import Widget from "./Missing.vue"; import Unused from "./Unused.vue"; import External from "external-package";</script><template><Widget/><External/></template>';
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, source);
  // Same-name catalog candidate must not replace an explicit unresolved binding.
  await writeFile(join(root, 'Widget.vue'), '<template><div/></template>');
  const options = { entryPath, targetPath: root };
  const missing = await getComponentTree(options);
  expect(missing.root.children).toEqual([]);
  expect(missing.totalComponents).toBe(1);
  expect(missing.diagnostics).toEqual([{
    code: 'UNRESOLVED_RENDERED_IMPORT', filePath: entryPath,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    specifier: './Missing.vue', identifier: 'Widget', resolution: 'unresolved',
    reason: "Rendered binding 'Widget' imports './Missing.vue', which the local resolver could not resolve.",
  }]);
  expect(formatTreeAsText(missing)).toContain('UNRESOLVED_RENDERED_IMPORT');
  expect(formatTreeAsText(missing)).toContain(missing.diagnostics![0].sourceHash);

  await writeFile(join(root, 'Missing.vue'), '<template><div/></template>');
  const resolved = await getComponentTree(options);
  expect(resolved.diagnostics).toEqual([]);
  expect(resolved.root.children.map(child => child.filePath)).toEqual([join(root, 'Missing.vue')]);

  await rm(join(root, 'Missing.vue'));
  expect((await getComponentTree(options)).diagnostics).toEqual(missing.diagnostics);
});

test('unresolved diagnostic follows the local alias rather than the exported name', async () => {
  root = await mkdtemp('/tmp/strata-tree-unresolved-alias-');
  await writeFile(join(root, 'package.json'), '{}');
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, '<script setup>import { Child as LocalChild } from "./Missing";</script><template><LocalChild/></template>');
  const result = await getComponentTree({ entryPath, targetPath: root });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics![0]).toMatchObject({ identifier: 'LocalChild', specifier: './Missing' });
});

test('tool handler preserves unresolved diagnostics in JSON text and retrieval omissions', async () => {
  root = await mkdtemp('/tmp/strata-tree-unresolved-handler-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, '<script setup>import Child from "./Missing.vue";</script><template><Child/></template>');
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  const args = { path: entryPath, target_path: root, direction: 'downward' };
  const json = await componentTreeTool.handler({ ...args, format: 'json' });
  expect(json.isError).not.toBe(true);
  const payload = JSON.parse(json.content[0].text);
  expect(payload.diagnostics).toHaveLength(1);
  expect(payload.diagnostics[0].code).toBe('UNRESOLVED_RENDERED_IMPORT');
  expect(payload.retrieval.completeness).toBe('partial');
  expect(payload.retrieval.omissions.some((item: { code: string }) => item.code === 'UNRESOLVED_RENDERED_IMPORT')).toBe(true);
  expect(json.structuredContent?.retrieval).toMatchObject(payload.retrieval);
  const text = await componentTreeTool.handler({ ...args, format: 'text' });
  expect(text.isError).not.toBe(true);
  expect(text.content[0].text).toContain('UNRESOLVED_RENDERED_IMPORT');
  expect(text.content[0].text).toContain('partial resolution');
});

async function chainFixture() {
  root = await mkdtemp('/tmp/strata-tree-boundaries-');
  await writeFile(join(root, 'package.json'), '{}');
  await mkdir(join(root, 'local'));
  const entryPath = join(root, 'local', 'App.vue');
  await writeFile(entryPath, '<script setup>import Child from "../Child.vue";</script><template><Child/></template>');
  await writeFile(join(root, 'Child.vue'), '<script setup>import Leaf from "./Leaf.vue";</script><template><Leaf/></template>');
  await writeFile(join(root, 'Leaf.vue'), '<template><div/></template>');
  return { entryPath, targetPath: root };
}

test('Vue depth boundary reports an unexpanded node and larger depth restores traversal', async () => {
  const options = await chainFixture();
  const bounded = await getComponentTree({ ...options, maxDepth: 1 });
  expect(bounded.root.children[0].children).toEqual([]);
  expect(bounded.diagnostics).toEqual([{
    code: 'MAX_DEPTH_REACHED', filePath: join(root, 'Child.vue'), sourceHash: null, depth: 1,
    reason: 'Node was not expanded because max depth 1 was reached; further dependencies were not inspected.',
  }]);
  expect(formatTreeAsText(bounded)).toContain('source SHA-256: not-captured');
  const expanded = await getComponentTree({ ...options, maxDepth: 3 });
  expect(expanded.root.children[0].children[0].filePath).toBe(join(root, 'Leaf.vue'));
  expect(expanded.diagnostics).toEqual([]);
});

test('Vue scope boundary retains external node and reports why it was not expanded', async () => {
  const options = await chainFixture();
  const result = await getComponentTree({ ...options, scopeFilter: join(root, 'local') });
  expect(result.root.children[0].isExternalScope).toBe(true);
  expect(result.root.children[0].children).toEqual([]);
  expect(result.diagnostics).toEqual([{
    code: 'SCOPE_BOUNDARY', filePath: join(root, 'Child.vue'), sourceHash: null, depth: 1,
    reason: 'Node was not expanded because it is outside the requested scope filter.',
  }]);
});

test('Vue source size rejection reports a failed read without fabricating a hash', async () => {
  const options = await chainFixture();
  // Sparse oversized source gives a deterministic read failure without permission races.
  await truncate(join(root, 'Child.vue'), 8 * 1024 * 1024 + 1);
  const result = await getComponentTree(options);
  expect(result.root.children[0].children).toEqual([]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics![0]).toMatchObject({
    code: 'SOURCE_READ_FAILED', filePath: join(root, 'Child.vue'), sourceHash: null, depth: 1,
  });
  expect(result.diagnostics![0].reason).toContain('SOURCE_TOO_LARGE');
  expect(formatTreeAsText(result)).toContain('SOURCE_READ_FAILED');
});

test('Vue rendered import cycle stops at the repeated file and emits source-bound omission', async () => {
  root = await mkdtemp('/tmp/strata-tree-cycle-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  const entryPath = join(root, 'App.vue');
  const childPath = join(root, 'Child.vue');
  const childSource = '<script setup>import App from "./App.vue";</script><template><App/></template>';
  await writeFile(entryPath, '<script setup>import Child from "./Child.vue";</script><template><Child/></template>');
  await writeFile(childPath, childSource);
  const options = { entryPath, targetPath: root, maxDepth: 10 };
  const result = await getComponentTree(options);
  expect(result.totalComponents).toBe(2);
  expect(result.root.children[0].children[0]).toMatchObject({ filePath: entryPath, depth: 2, isCircular: true, children: [] });
  expect(result.diagnostics).toEqual([{
    code: 'CYCLE_TRUNCATED', filePath: childPath,
    sourceHash: createHash('sha256').update(childSource).digest('hex'),
    targetPath: entryPath, depth: 2,
    reason: `Traversal stopped at '${entryPath}' because this file already occurs in the current branch.`,
  }]);
  expect(formatTreeAsText(result)).toContain('CYCLE_TRUNCATED');
  expect(await getComponentTree(options)).toEqual(result);

  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  const json = await componentTreeTool.handler({ path: entryPath, target_path: root, max_depth: 10, format: 'json' });
  expect(json.isError).not.toBe(true);
  const payload = JSON.parse(json.content[0].text);
  expect(payload.diagnostics).toEqual(result.diagnostics);
  expect(payload.retrieval.omissions.some((item: { code: string }) => item.code === 'CYCLE_TRUNCATED')).toBe(true);
  expect(payload.retrieval.completeness).toBe('partial');
});

test('Vue shared descendant in sibling branches is not classified as a cycle', async () => {
  root = await mkdtemp('/tmp/strata-tree-diamond-');
  await writeFile(join(root, 'package.json'), '{}');
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, '<script setup>import Left from "./Left.vue"; import Right from "./Right.vue";</script><template><Left/><Right/></template>');
  for (const branch of ['Left', 'Right']) {
    await writeFile(join(root, `${branch}.vue`), '<script setup>import Leaf from "./Leaf.vue";</script><template><Leaf/></template>');
  }
  await writeFile(join(root, 'Leaf.vue'), '<template><div/></template>');
  const result = await getComponentTree({ entryPath, targetPath: root, maxDepth: 4 });
  expect(result.totalComponents).toBe(4);
  expect(result.root.children.map(node => node.children[0].filePath)).toEqual([join(root, 'Leaf.vue'), join(root, 'Leaf.vue')]);
  expect(result.root.children.every(node => !node.children[0].isCircular)).toBe(true);
  expect(result.diagnostics).toEqual([]);
});

test('Vue catalog fallback cycle emits a diagnostic without inventing explicit imports', async () => {
  root = await mkdtemp('/tmp/strata-tree-catalog-cycle-');
  await writeFile(join(root, 'package.json'), '{}');
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, '<template><Child/></template>');
  await writeFile(join(root, 'Child.vue'), '<template><App/></template>');
  const result = await getComponentTree({ entryPath, targetPath: root, maxDepth: 10 });
  expect(result.totalComponents).toBe(2);
  expect(result.root.children[0].children[0]).toMatchObject({ filePath: entryPath, isCircular: true, isAutoImported: true, children: [] });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics![0]).toMatchObject({ code: 'CYCLE_TRUNCATED', filePath: join(root, 'Child.vue'), targetPath: entryPath, depth: 2 });
});

test.each([
  ['<template><Child></template>', 'VUE_PARSE_FAILED'],
  ['<template><div id="first" id="second"/></template>', 'VUE_PARSE_FAILED'],
  ['<template lang="pug">Child</template>', 'VUE_TEMPLATE_UNSUPPORTED'],
  ['<template src="./view.html"></template>', 'VUE_TEMPLATE_UNSUPPORTED'],
])('Vue tree reports source-bound input failure for %s', async (source, code) => {
  root = await mkdtemp('/tmp/strata-tree-invalid-vue-');
  await writeFile(join(root, 'package.json'), '{}');
  const entryPath = join(root, 'App.vue');
  await writeFile(entryPath, source);
  await writeFile(join(root, 'Child.vue'), '<template><div/></template>');
  const result = await getComponentTree({ entryPath, targetPath: root });
  expect(result.root.children).toEqual([]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics![0]).toMatchObject({ code, filePath: entryPath, depth: 0,
    sourceHash: createHash('sha256').update(source).digest('hex') });
  expect(formatTreeAsText(result)).toContain(code);
});

test('valid Vue template is traversed after a malformed child is repaired', async () => {
  const options = await chainFixture();
  await writeFile(join(root, 'Child.vue'), '<template><Leaf></template>');
  const malformed = await getComponentTree(options);
  expect(malformed.root.children[0].children).toEqual([]);
  expect(malformed.diagnostics![0]).toMatchObject({ code: 'VUE_PARSE_FAILED', filePath: join(root, 'Child.vue'), depth: 1 });
  await writeFile(join(root, 'Child.vue'), '<script setup>import Leaf from "./Leaf.vue";</script><template><Leaf/></template>');
  const repaired = await getComponentTree(options);
  expect(repaired.root.children[0].children[0].filePath).toBe(join(root, 'Leaf.vue'));
  expect(repaired.diagnostics).toEqual([]);
});

test('Vue dynamic component inventory has exact directive spans and candidate resolution', async () => {
  root = await mkdtemp('/tmp/strata-tree-dynamic-');
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  const entryPath = join(root, 'App.vue');
  const source = '<script setup>import Child from "./Child.vue";</script>\r\n<template>🙂<!-- <component :is="decoy"/> --><component\n :is="selected"/><div :is="unrelated"/><component v-bind:is="Child"/><Child/></template>';
  await writeFile(entryPath, source);
  await writeFile(join(root, 'Child.vue'), '<template><div/></template>');
  const result = await getComponentTree({ entryPath, targetPath: root });
  const dynamic = result.diagnostics!.filter(item => item.code === 'VUE_DYNAMIC_COMPONENT');
  expect(dynamic).toHaveLength(2);
  const expected = [':is="selected"', 'v-bind:is="Child"'];
  for (let index = 0; index < dynamic.length; index++) {
    const item = dynamic[index];
    if (item.code !== 'VUE_DYNAMIC_COMPONENT') throw new Error('Expected dynamic diagnostic');
    expect(item.resolution).toBe('candidate');
    expect(item.expression).toBe(index === 0 ? 'selected' : 'Child');
    expect(item.sourceRef).toEqual({ sha256: createHash('sha256').update(source).digest('hex'),
      startOffset: source.indexOf(expected[index]), endOffset: source.indexOf(expected[index]) + expected[index].length });
    expect(source.slice(item.sourceRef.startOffset, item.sourceRef.endOffset)).toBe(expected[index]);
  }
  expect(result.root.children.some(node => node.filePath === join(root, 'Child.vue'))).toBe(true);
  expect(formatTreeAsText(result)).toContain('VUE_DYNAMIC_COMPONENT');
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  const response = await componentTreeTool.handler({ path: entryPath, target_path: root, format: 'json' });
  expect(response.isError).not.toBe(true);
  const payload = JSON.parse(response.content[0].text);
  expect(payload.retrieval.omissions.filter((item: { code: string }) => item.code === 'VUE_DYNAMIC_COMPONENT')).toHaveLength(2);
  expect(payload.retrieval.completeness).toBe('partial');
});

test('Vue selector inventory distinguishes literal bound dynamic-key and object inputs', async () => {
  root = await mkdtemp('/tmp/strata-tree-selector-kinds-');
  await writeFile(join(root, 'package.json'), '{}');
  const entryPath = join(root, 'App.vue');
  const source = '<template>🙂\r\n<!-- <component is="decoy"/> --><component is="Child"/><component :is="selected"/><component v-bind:[key]="value"/><component v-bind="attrs"/><component :title="title"/><div is="ordinary" v-bind="other"/></template>';
  await writeFile(entryPath, source);
  const expected = [
    { kind: 'static-is', argument: 'is', expression: 'Child', snippet: 'is="Child"' },
    { kind: 'bound-is', argument: 'is', expression: 'selected', snippet: ':is="selected"' },
    { kind: 'dynamic-argument', argument: 'key', expression: 'value', snippet: 'v-bind:[key]="value"' },
    { kind: 'object-binding', argument: null, expression: 'attrs', snippet: 'v-bind="attrs"' },
  ];
  expect(collectVueDynamicTreeInputs(source, entryPath)).toEqual(expected.map(({ snippet, ...input }) => ({
    ...input, startOffset: source.indexOf(snippet), endOffset: source.indexOf(snippet) + snippet.length,
  })));
  const tree = await getComponentTree({ entryPath, targetPath: root });
  const diagnostics = tree.diagnostics!.filter(item => item.code === 'VUE_DYNAMIC_COMPONENT');
  expect(diagnostics).toHaveLength(4);
  for (let index = 0; index < diagnostics.length; index++) {
    const item = diagnostics[index];
    if (item.code !== 'VUE_DYNAMIC_COMPONENT') throw new Error('Expected dynamic diagnostic');
    expect(item.selectorKind).toBe(expected[index].kind);
    expect(item.argument).toBe(expected[index].argument);
    expect(item.resolution).toBe('candidate');
    expect(source.slice(item.sourceRef.startOffset, item.sourceRef.endOffset)).toBe(expected[index].snippet);
    expect(item.sourceHash).toBe(createHash('sha256').update(source).digest('hex'));
    if (index >= 2) expect(item.reason).toContain("may supply the 'is' selector");
  }
  expect(formatTreeAsText(tree)).toContain('object-binding');
});
