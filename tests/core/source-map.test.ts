import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapSourceFile } from '../../src/engine/source-map';
import { readSourceRef } from '../../src/engine/source-file';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

async function mapFixture(name: string, source: string) {
  root = await mkdtemp(join(tmpdir(), 'strata-source-map-'));
  const file = join(root, name);
  await writeFile(file, source);
  return { file, result: await mapSourceFile(file) };
}

test('maps Vue SFC blocks to exact original source spans', async () => {
  const source = '<script setup lang="ts">\nconst label = "café";\n</script>\n<template>\n  <h1>{{ label }}</h1>\n</template>\n<style scoped>\nh1 { color: red }\n</style>\n';
  const { file, result } = await mapFixture('Page.vue', source);
  const blocks = result.regions.filter(region => region.kind === 'block');

  expect(result.framework).toBe('vue');
  expect(blocks.map(region => region.name)).toEqual(['scriptSetup', 'template', 'style']);
  expect(await readSourceRef(file, blocks[0].ref)).toBe('\nconst label = "café";\n');
  expect(blocks[0].attributes).toEqual({ lang: 'ts', setup: true });
  expect(blocks[0].span.start.line).toBe(1);
  expect(blocks[0].children?.[0].name).toBe('label');
  const template = blocks.find(region => region.name === 'template');
  expect(template?.children?.[0].name).toBe('h1');
  expect(await readSourceRef(file, template!.children![0].ref)).toBe('<h1>{{ label }}</h1>');
});

test('maps Astro frontmatter/template and reports malformed frontmatter', async () => {
  const { result } = await mapFixture('Page.astro', '---\nconst title = "Astro";\n---\n<h1>{title}</h1>');
  expect(result.framework).toBe('astro');
  expect(result.regions.map(region => region.kind)).toEqual(['frontmatter', 'template']);
  expect(result.regions[0].children?.[0].name).toBe('title');

  const malformed = await mapFixture('Broken.astro', '---\nconst title = "unclosed";');
  expect(malformed.result.status).toBe('partial');
  expect(malformed.result.diagnostics[0]?.code).toBe('ASTRO_FRONTMATTER_UNCLOSED');
});

test('maps TypeScript and JSX declarations with source ranges', async () => {
  const { result } = await mapFixture('Card.tsx', 'type Props = { title: string };\nexport function Card(props: Props) {\n  return <article>{props.title}</article>;\n}\n');
  const symbols = result.regions.filter(region => region.kind === 'symbol');
  const jsx = symbols.flatMap(region => region.children ?? []).filter(region => region.kind === 'jsx');

  expect(result.framework).toBe('react');
  expect(symbols.map(region => region.name)).toEqual(['Props', 'Card']);
  expect(jsx).toHaveLength(1);
  expect(jsx[0].span.start.line).toBe(3);
});

test('bounds large symbol maps and marks incomplete coverage', async () => {
  const { file } = await mapFixture('Bounded.tsx', 'export const One = () => <div />;\nexport const Two = () => <span />;');
  const bounded = await mapSourceFile(file, { maxRegions: 1 });
  expect(bounded.regions).toHaveLength(1);
  expect(bounded.status).toBe('partial');
  expect(bounded.coverage?.truncated).toBe(true);
});
