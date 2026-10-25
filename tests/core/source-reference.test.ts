import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSourceLineRange,
  getSourcePosition,
  readSourceRef,
  readSourceSnapshot,
} from '../../src/engine/source-file';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

async function sourceFile(content: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'strata-source-ref-'));
  const path = join(root, 'component.tsx');
  await writeFile(path, content);
  return path;
}

test('source snapshot hashes original UTF-8 bytes and reports source coordinates', async () => {
  const content = 'first\r\n🙂x\nlast\r';
  const path = await sourceFile(content);
  const result = await readSourceSnapshot(path);

  expect(result.content).toBe(content);
  expect(result.snapshot.sha256).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));
  expect(result.snapshot.offsetUnit).toBe('utf16');
  expect(result.snapshot.lineCount).toBe(4);
  expect(getSourcePosition(content, content.indexOf('x'))).toEqual({ line: 2, column: 3, offset: content.indexOf('x') });
});

test('inclusive line ranges preserve original internal line endings and include empty final lines', async () => {
  const content = 'one\r\ntwo\n';
  const path = await sourceFile(content);
  const { snapshot, content: source } = await readSourceSnapshot(path);
  const selected = getSourceLineRange(snapshot, source, 1, 2);
  const finalLine = getSourceLineRange(snapshot, source, 3, 3);

  expect(await readSourceRef(path, selected.ref)).toBe('one\r\ntwo');
  expect(finalLine.lineRange).toEqual({ startLine: 3, endLine: 3 });
  expect(await readSourceRef(path, finalLine.ref)).toBe('');
});

test('stale, out-of-bounds and surrogate-splitting references are rejected', async () => {
  const path = await sourceFile('a🙂b');
  const { snapshot } = await readSourceSnapshot(path);

  await expect(readSourceRef(path, { sha256: snapshot.sha256, startOffset: 2, endOffset: 3 }))
    .rejects.toThrow('INVALID_SOURCE_REF');
  await expect(readSourceRef(path, { sha256: snapshot.sha256, startOffset: 0, endOffset: 99 }))
    .rejects.toThrow('INVALID_SOURCE_REF');

  await writeFile(path, 'changed');
  await expect(readSourceRef(path, { sha256: snapshot.sha256, startOffset: 0, endOffset: 1 }))
    .rejects.toThrow('STALE_SOURCE_REF');
});
