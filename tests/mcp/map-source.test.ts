import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { findCodeTool } from '../../src/tools/find-code';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

test('inspect maps source and retrieves only the hash-validated selected region', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-source-'));
  const file = join(root, 'Card.vue');
  await writeFile(file, '<script setup>\nconst title = "Card";\n</script>\n<template>\n  <h1>{{ title }}</h1>\n</template>');

  const mapped = await inspectComponentTool.handler({ path: file, project_root: root, view: 'map', format: 'json' });
  const result = JSON.parse(mapped.content[0].text);
  expect(result.regions.map((item: any) => item.name)).toEqual(['scriptSetup', 'template']);
  const sliced = await inspectComponentTool.handler({ path: file, project_root: root, view: 'source', source_ref: result.regions[1].ref });
  expect(sliced.content[0].text).toBe('\n  <h1>{{ title }}</h1>\n');

  await writeFile(file, '<script setup>\nconst title = "Changed";\n</script>\n<template>\n  <h1>{{ title }}</h1>\n</template>');
  const stale = await inspectComponentTool.handler({ path: file, project_root: root, view: 'source', source_ref: result.regions[1].ref });
  expect(stale.isError).toBe(true);
  expect(stale.content[0].text).toContain('STALE_SOURCE_REF');
});

test('legacy inclusive source_range clamps end_line to EOF and rejects invalid start_line', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-source-'));
  const file = join(root, 'App.ts');
  await writeFile(file, 'const one = 1;\r\nconst two = 2;');
  const selected = await inspectComponentTool.handler({ path: file, project_root: root, source_range: { start_line: 2, end_line: 2 } });
  expect(selected.content[0].text).toBe('const two = 2;');
  const clamped = await inspectComponentTool.handler({ path: file, project_root: root, source_range: { start_line: 1, end_line: 10 }, format: 'text' });
  expect(clamped.isError).not.toBe(true);
  expect(clamped.content[0].text).toBe('const one = 1;\r\nconst two = 2;');
  expect(clamped.structuredContent).toMatchObject({ startLine: 1, endLine: 2, clamped: true, requestedEndLine: 10 });
  const footer = clamped.content.map((c: any) => c.text).join('\n');
  expect(footer).toContain('[strata: ok | source_range |');
  expect(footer).toContain('clamped to EOF from L10');
  expect(footer).not.toContain('Capability limit:');

  const invalidStart = await inspectComponentTool.handler({ path: file, project_root: root, source_range: { start_line: 3, end_line: 5 } });
  expect(invalidStart.isError).toBe(true);
  expect(invalidStart.content[0].text).toContain('INVALID_SOURCE_RANGE');
  const conflicting = await inspectComponentTool.handler({ path: file, project_root: root, view: 'map', symbol: 'two' });
  expect(conflicting.isError).toBe(true);
  const conflictingLegacy = await inspectComponentTool.handler({ path: file, project_root: root, symbol: 'two', outline: true });
  expect(conflictingLegacy.isError).toBe(true);
});

test('source_range on ~8 KB file succeeds within default 16 KB budget in text mode without structured duplication', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-budget-'));
  const file = join(root, 'types.ts');
  const lines = Array.from({ length: 180 }, (_, i) => `export interface FieldType_${i} { id: number; value: string; }`);
  const content = lines.join('\n');
  expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(7000);
  await writeFile(file, content);

  const res = await inspectComponentTool.handler({
    path: file,
    project_root: root,
    source_range: { start_line: 1, end_line: 180 },
    format: 'text',
    response_detail: 'full',
  });
  expect(res.isError).not.toBe(true);
  expect(res.content[0].text).toBe(content);
  expect(res.structuredContent).not.toHaveProperty('source');
  expect(res.content).toHaveLength(2);
  expect(res.content[1].text).toMatch(/^\[strata: ok \| source_range \| sha256:[a-f0-9]{12} \| L1-180\]$/);
});

test('find_code action map returns bounded inventory without source text', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-source-'));
  await writeFile(join(root, 'package.json'), '{"dependencies":{"react":"^19"}}');
  await writeFile(join(root, 'Page.tsx'), 'export default function Page() { return <main>secret</main> }');
  const result = await findCodeTool.handler({ path: root, action: 'map', limit: 1, format: 'json' });
  const map = JSON.parse(result.content[0].text);
  expect(map.coverage.returnedFiles).toBe(1);
  expect(map.files[0].path).toBe(join(root, 'Page.tsx'));
  expect(result.content[0].text).not.toContain('secret');
});

test('view: map format: text emits copyable full 64-char SHA-256 and offsets that work directly in view: source', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-text-'));
  const file = join(root, 'manager.ts');
  await writeFile(file, 'export interface Opts { a: number }\n\nexport function run(x: number) {\n  return x + 1;\n}\n');

  const mapped = await inspectComponentTool.handler({ path: file, project_root: root, view: 'map', format: 'text' });
  expect(mapped.isError).not.toBe(true);
  const text = mapped.content[0].text;
  const shaMatch = text.match(/SHA-256 \(source_ref\.sha256\): ([a-f0-9]{64}) \| Lines: (\d+)/i);
  expect(shaMatch).not.toBeNull();
  expect(shaMatch![2]).toBe('6');

  const regionMatch = text.match(/- symbol run: lines 3-5 \(offsets: (\d+)-(\d+)\)/);
  expect(regionMatch).not.toBeNull();

  const sliced = await inspectComponentTool.handler({
    path: file,
    project_root: root,
    view: 'source',
    format: 'text',
    source_ref: {
      sha256: shaMatch![1],
      startOffset: Number(regionMatch![1]),
      endOffset: Number(regionMatch![2]),
    },
  });
  expect(sliced.isError).not.toBe(true);
  expect(sliced.content[0].text).toBe('export function run(x: number) {\n  return x + 1;\n}');
});

test('find_code action map includes src/tools and reports excluded directories in text mode', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-tools-'));
  await mkdir(join(root, 'src', 'tools'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;');
  await writeFile(join(root, 'src', 'tools', 'network.ts'), 'export const net = 1;');
  await writeFile(join(root, 'scripts', 'seed.ts'), 'export const seed = 1;');

  const res = await findCodeTool.handler({ path: root, action: 'map', format: 'text' });
  expect(res.isError).not.toBe(true);
  const text = res.content[0].text;
  expect(text).toContain(join(root, 'src', 'tools', 'network.ts'));
  expect(text).toContain('Status: complete (excluding 1 directory); 2/2 files returned');
  expect(text).toContain('Excluded directories: scripts (default-ignore)');
});
