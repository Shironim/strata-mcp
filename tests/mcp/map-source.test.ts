import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('legacy inclusive source_range remains exact and rejects out-of-bounds ranges', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-map-source-'));
  const file = join(root, 'App.ts');
  await writeFile(file, 'const one = 1;\r\nconst two = 2;');
  const selected = await inspectComponentTool.handler({ path: file, project_root: root, source_range: { start_line: 2, end_line: 2 } });
  expect(selected.content[0].text).toBe('const two = 2;');
  const invalid = await inspectComponentTool.handler({ path: file, project_root: root, source_range: { start_line: 1, end_line: 3 } });
  expect(invalid.isError).toBe(true);
  const conflicting = await inspectComponentTool.handler({ path: file, project_root: root, view: 'map', symbol: 'two' });
  expect(conflicting.isError).toBe(true);
  const conflictingLegacy = await inspectComponentTool.handler({ path: file, project_root: root, symbol: 'two', outline: true });
  expect(conflictingLegacy.isError).toBe(true);
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
