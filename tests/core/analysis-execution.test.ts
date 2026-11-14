import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { withAnalysisContext, analysisSyntaxCache } from '../../src/engine/analysis-context';
import { parseTypeScript } from '../../src/engine/source-parser';
import { executeAstGrep, dumpSyntaxTree } from '../../src/engine/astgrep';
import { findCode } from '../../src/engine/search';
import { runConcurrent, collectConcurrentMatches } from '../../src/engine/pool';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

test('syntax reuse is bound to request, filename, parser kind and exact source', () => {
  const first = withAnalysisContext(() => {
    const source = parseTypeScript('A.ts', 'const value = 1;');
    expect(parseTypeScript('A.ts', 'const value = 1;')).toBe(source);
    expect(parseTypeScript('A.ts', 'const value = 2;')).not.toBe(source);
    expect(parseTypeScript('B.ts', 'const value = 1;')).not.toBe(source);
    expect(parseTypeScript('A.ts', 'const value = 1;', ts.ScriptKind.TS)).not.toBe(source);
    for (let i = 0; i < 50; i++) parseTypeScript(`${i}.ts`, 'const x = 0;');
    expect(analysisSyntaxCache()?.syntax.size).toBe(32);
    return source;
  });
  expect(withAnalysisContext(() => parseTypeScript('A.ts', 'const value = 1;'))).not.toBe(first);
  expect(analysisSyntaxCache()).toBeUndefined();
});

test('large sources are parsed without retaining them in the request syntax cache', () => {
  withAnalysisContext(() => {
    const source = '/*' + 'x'.repeat(1_100_000) + '*/';
    const first = parseTypeScript('large.ts', source);
    expect(parseTypeScript('large.ts', source)).not.toBe(first);
    expect(analysisSyntaxCache()?.syntax.size).toBe(0);
  });
});

test('bounded match collection preserves order and does not start later batches', async () => {
  const visited: number[] = [];
  const result = await collectConcurrentMatches([0, 1, 2, 3, 4], async i => { visited.push(i); return [i, i]; }, 3, 2);
  expect(result).toEqual([0, 0, 1]);
  expect(visited).toEqual([0, 1]);
});

test('pool failure stops admission and waits for sibling execution to settle', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const visited: number[] = [];
  let settled = false;
  const operation = runConcurrent([0, 1, 2, 3], async i => {
    visited.push(i);
    if (i === 0) { await entered.promise; throw new Error('failed'); }
    entered.resolve(); await gate.promise;
    return i;
  }, 2).catch(error => { settled = true; return error.message; });
  await entered.promise; await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve();
  expect(await operation).toBe('failed');
  expect(visited).toEqual([0, 1]);
});

test('AST search stops before reading files beyond the requested match limit', async () => {
  root = await mkdtemp('/tmp/strata-bounded-search-');
  await writeFile(join(root, 'A.ts'), 'const first = ref(1);');
  await writeFile(join(root, 'B.ts'), ' '.repeat(8 * 1024 * 1024 + 1));
  const result = await findCode({ targetPath: root, pattern: 'ref($$$)', maxResults: 1 });
  expect(result).toHaveLength(1);
  expect(result[0].file).toBe(join(root, 'A.ts'));
  await expect(findCode({ targetPath: root, pattern: 'ref($$$)', maxResults: 2 })).rejects.toThrow('SOURCE_TOO_LARGE');
});

for (const action of ['search', 'dump'] as const) {
test.skipIf(process.platform === 'win32')(`${action} cancellation terminates the running AST subprocess and cleans its input directory`, async () => {
  root = await mkdtemp('/tmp/strata-cancel-process-');
  const pidPath = join(root, 'pid'), binary = join(root, 'fake-ast-grep');
  await writeFile(binary, `#!/bin/sh\necho $$ > '${pidPath}'\nexec sleep 60\n`, { mode: 0o700 });
  const oldBinary = process.env.AST_GREP_BIN;
  const controller = new AbortController();
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('strata-ast-input-')));
  process.env.AST_GREP_BIN = binary;
  const operation = withAnalysisContext(() => action === 'search'
    ? executeAstGrep({ code: 'ref(1)', pattern: 'ref($$$)' })
    : dumpSyntaxTree('ref(1)'), controller.signal).catch(error => error as Error);
  try {
    for (let i = 0; i < 100 && !existsSync(pidPath); i++) await Bun.sleep(10);
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    controller.abort(new Error('REQUEST_CANCELLED: test cancellation'));
    expect((await operation as Error).message).toContain('REQUEST_CANCELLED');
    expect(() => process.kill(pid, 0)).toThrow();
    const added = (await readdir(tmpdir())).filter(name => name.startsWith('strata-ast-input-') && !before.has(name));
    expect(added).toEqual([]);
  } finally {
    controller.abort(); await operation;
    if (oldBinary === undefined) delete process.env.AST_GREP_BIN;
    else process.env.AST_GREP_BIN = oldBinary;
  }
});
}
