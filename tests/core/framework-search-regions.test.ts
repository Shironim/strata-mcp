import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findCodeTool } from '../../src/tools/find-code';

test('public pattern and YAML searches find source-local calls across framework regions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'strata-region-test-'));
  const sources = {
    'View.vue': '<script setup>probe(1)</script>\n<template>{{ probe(2) }}</template>',
    'View.tsx': 'probe(1); const view = <div>{probe(2)}</div>',
    'View.svelte': [
      '\uFEFF<script module>probe(1)</script>', '<script>probe(2)</script>',
      '{#if probe(3)}<button onclick={() => probe(4)}>é🙂{probe(5)}{probe(6)}</button>{/if}',
      '<p onclick={probe}>probe(99) {"probe(99)"}</p><!-- {probe(99)} -->',
      '<p>{probe}{(99)}</p>', '<p>{', '  ["🙂",probe(7)]', '}</p>',
    ].join('\n'),
    'View.astro': [
      '---', 'probe(1)', '---', '<p data-x={wrap({x:probe(2)})} title="{probe(99)}">é🙂{probe(3)}</p>',
      '<script>probe(4)</script>', '<script type="application/json">{"text":"probe(99)"}</script>',
      '<script src="./external.js">probe(99)</script>', '<!-- {probe(99)} -->',
      '<p>{`x${probe(5)}`}</p>', '<p>{"probe(99)"} probe(99)</p>', '<p>{active && <Card value={probe(6)} />}</p>',
    ].join('\n'),
  };
  try {
    for (const [file, content] of Object.entries(sources)) writeFileSync(join(root, file), content);
    writeFileSync(join(root, 'Malformed.svelte'), '<p>{#if broken');
    const expected = Object.entries(sources).flatMap(([file, content]) => content.split('\n').flatMap((line, i) =>
      [...line.matchAll(/probe\([1-7]\)/g)].map(m => [file, i + 1, m.index! + 1, i + 1, m.index! + m[0].length + 1, m[0]].join('|')))).sort();
    for (const selector of [{pattern:'probe($A)'}, {rule_yaml:'id: calls\nlanguage: Tsx\nrule:\n  pattern: probe($A)'}]) {
      const response = await findCodeTool.handler({ path: root, format:'json', ...selector });
      expect(response.isError).toBeFalsy();
      const rows = JSON.parse(response.content[0].text);
      expect(rows.map((r: any) => [basename(r.file), r.line, r.column, r.endLine, r.endColumn, r.snippet].join('|')).sort()).toEqual(expected);
      const limited = await findCodeTool.handler({ path: root, format:'json', max_results: 2, ...selector });
      expect(JSON.parse(limited.content[0].text)).toHaveLength(2);
    }
    const literal = await findCodeTool.handler({ path: root, format: 'json', mode: 'literal', pattern: 'probe(99)' });
    expect(JSON.parse(literal.content[0].text).length).toBeGreaterThan(0);
    const tag = await findCodeTool.handler({ path: root, format: 'json', language: 'html', pattern: '<button $$$>$$$</button>' });
    expect(JSON.parse(tag.content[0].text).some((r: { file: string }) => basename(r.file) === 'View.svelte')).toBe(true);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
