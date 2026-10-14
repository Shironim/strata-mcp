import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodeTool } from '../../src/tools/find-code';
import { inspectComponentTool } from '../../src/tools/inspect-component';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-search-modes-'));
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'sample.ts'), '// resolves tsconfig compilerOptions.paths aliases\nconst asset = "transformer.webp";\nconsole.log("hello");\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('literal searches exact text with source coordinates and a result limit', async () => {
  const r = await findCodeTool.handler({ path: root, pattern: 'transformer.webp', mode: 'literal', format: 'json', max_results: 1 });
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(r.content[0].text)).toEqual([expect.objectContaining({ file: join(root, 'sample.ts'), line: 2, column: 16 })]);
  expect((r as any).structuredContent.modeUsed).toBe('literal');
  const escaped = await findCodeTool.handler({ path: root, pattern: 'transformer\\.webp', mode: 'literal', format: 'json' });
  expect(JSON.parse(escaped.content[0].text)).toEqual([]);
});

test('auto reports literal fallback while strict AST returns a parse error', async () => {
  const args = { path: root, pattern: 'resolves tsconfig compilerOptions.paths aliases', format: 'json' };
  const auto = await findCodeTool.handler({ ...args, mode: 'auto' });
  expect(auto.isError).toBeUndefined();
  expect(JSON.parse(auto.content[0].text)).toHaveLength(1);
  expect((auto as any).structuredContent.modeUsed).toBe('literal');
  expect((auto as any).structuredContent.fallbackReason).toBeDefined();
  expect((await findCodeTool.handler({ ...args, mode: 'ast' })).isError).toBe(true);
});

test('valid AST returns structural matches as a JSON array', async () => {
  const r = await findCodeTool.handler({ path: root, pattern: 'console.log($$$)', mode: 'auto', format: 'json' });
  expect(JSON.parse(r.content[0].text)).toEqual([expect.objectContaining({ line: 3, snippet: 'console.log("hello")' })]);
  expect((r as any).structuredContent.modeUsed).toBe('ast');
});

test('literal in-memory search works without the binary, but auto does not hide a missing binary', async () => {
  const original = process.env.AST_GREP_BIN;
  process.env.AST_GREP_BIN = join(root, 'Cannot parse query as a valid pattern');
  try {
    const literal = await findCodeTool.handler({ code: 'const image = "transformer.webp";', pattern: 'transformer.webp', mode: 'literal', format: 'json' });
    expect(JSON.parse(literal.content[0].text).matches).toHaveLength(1);
    const auto = await findCodeTool.handler({ path: root, pattern: 'console.log($$$)', mode: 'auto' });
    expect(auto.isError).toBe(true);
  } finally {
    if (original === undefined) delete process.env.AST_GREP_BIN;
    else process.env.AST_GREP_BIN = original;
  }
});

test('invalid search mode is rejected and literal mode cannot silently override YAML', async () => {
  expect((await findCodeTool.handler({ path: root, pattern: 'hello', mode: 'wrong' })).isError).toBe(true);
  expect((await findCodeTool.handler({ path: root, rule_yaml: 'bad', mode: 'literal' })).isError).toBe(true);
});

test('missing component suggests matching candidates without selecting a different file', async () => {
  await mkdir(join(root, 'components'));
  await writeFile(join(root, 'components', 'TaskRow.tsx'), 'export const TaskRow = () => <div />;');
  const result = await inspectComponentTool.handler({ path: join(root, 'TaskRow.vue'), project_root: root, format: 'json' });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).suggestions).toEqual([join(root, 'components', 'TaskRow.tsx')]);
});

test('literal traversal respects ignored paths and includes Vue template text', async () => {
  await writeFile(join(root, '.strataignore'), 'ignored/\n');
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, 'ignored', 'Hidden.ts'), '// transformer.webp');
  await writeFile(join(root, 'Image.vue'), '<template><img src="transformer.webp" /></template>');
  const r = await findCodeTool.handler({ path: root, pattern: 'transformer.webp', mode: 'literal', format: 'json' });
  const matches = JSON.parse(r.content[0].text);
  expect(matches.map((m: any) => m.file).sort()).toEqual([join(root, 'Image.vue'), join(root, 'sample.ts')]);
});

test('auto handles an invalid query even when keyword pruning would skip every file', async () => {
  const r = await findCodeTool.handler({ path: root, pattern: 'absent words with spaces', mode: 'auto', format: 'json' });
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(r.content[0].text)).toEqual([]);
  expect((r as any).structuredContent.modeUsed).toBe('literal');
});

test('candidate suggestions preserve ambiguity and stay within the explicit workspace', async () => {
  await writeFile(join(root, 'TaskRow.tsx'), 'export const TaskRow = () => <div />;');
  await writeFile(join(root, 'TaskRow.vue'), '<template><div /></template>');
  const ambiguous = await inspectComponentTool.handler({ path: join(root, 'missing', 'TaskRow.jsx'), project_root: root, format: 'json' });
  expect(ambiguous.isError).toBe(true);
  expect(JSON.parse(ambiguous.content[0].text).suggestions).toHaveLength(2);
  const outside = await inspectComponentTool.handler({ path: join(root, '..', 'TaskRow.jsx'), project_root: root, format: 'json' });
  expect(JSON.parse(outside.content[0].text).suggestions).toEqual([]);
});

test('literal mode requires a pattern rather than implicitly dumping the snippet AST', async () => {
  const r = await findCodeTool.handler({ code: 'const x = 1;', mode: 'literal' });
  expect(r.isError).toBe(true);
});

test('snippet AST defaults to TypeScript and matches only the type assertion', async () => {
  const r = await findCodeTool.handler({ code: 'const value = <number>input + offset;', pattern: '<$TYPE>$EXPR', format: 'json' });
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(r.content[0].text).matches).toEqual([
    expect.objectContaining({ text: '<number>input', column: 15, endColumn: 28 }),
  ]);
});

test('snippet text fallback announces literal search with source coordinates', async () => {
  const r = await findCodeTool.handler({
    code: '// resolves tsconfig compilerOptions.paths aliases',
    pattern: 'resolves tsconfig compilerOptions.paths aliases', mode: 'auto', format: 'text',
  });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain('[Notice: Invalid AST pattern; used exact literal line search.]');
  expect(r.content[0].text).toContain('<snippet>:1:4 - // resolves tsconfig compilerOptions.paths aliases');
  expect(r.structuredContent).toEqual({ modeRequested: 'auto', modeUsed: 'literal', fallbackReason: 'invalid_ast_pattern' });
});

test('snippet output defaults to text and reports zero matches without fallback', async () => {
  const r = await findCodeTool.handler({ code: 'const value = 1;', pattern: 'console.log($$$)', mode: 'auto' });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toBe('No matches found.');
  expect(r.structuredContent).toEqual({ modeRequested: 'auto', modeUsed: 'ast' });
});

test('YAML snippets use result limits without pattern-mode metadata', async () => {
  const args = {
    code: 'console.log(1);\n'.repeat(205),
    rule_yaml: 'id: logs\nlanguage: TypeScript\nrule:\n  pattern: console.log($$$)', format: 'json',
  };
  const defaults = await findCodeTool.handler(args);
  expect(defaults.isError).toBeUndefined();
  expect(JSON.parse(defaults.content[0].text).matchCount).toBe(200);
  expect(defaults.structuredContent).toBeUndefined();
  const limited = await findCodeTool.handler({ ...args, max_results: 2 });
  expect(JSON.parse(limited.content[0].text).matches).toHaveLength(2);
});

test('explicit suggestion root needs no project marker and still rejects scope escapes', async () => {
  await rm(join(root, 'package.json'));
  await writeFile(join(root, 'TaskRow.tsx'), 'export const TaskRow = () => <div />;');
  const r = await inspectComponentTool.handler({ path: join(root, 'missing', 'TaskRow.vue'), project_root: root, format: 'json' });
  expect(r.isError).toBe(true);
  expect(JSON.parse(r.content[0].text).suggestions).toEqual([join(root, 'TaskRow.tsx')]);
  const outside = await inspectComponentTool.handler({ path: join(root, '..', 'TaskRow.vue'), project_root: root, format: 'json' });
  expect(JSON.parse(outside.content[0].text).suggestions).toEqual([]);
});
