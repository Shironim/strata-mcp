import { promises as fs, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SourceLineRange, SourcePosition, SourceRef, SourceSnapshot } from '../types';

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function assertSourceSize(bytes: number, path: string): void {
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`SOURCE_TOO_LARGE: ${path} exceeds 8 MiB`);
}

export { getSourcePosition } from '../utils/source-position';

export async function readSourceSnapshot(path: string): Promise<{ snapshot: SourceSnapshot; content: string }> {
  const filePath = resolve(path);
  const file = await fs.open(filePath, 'r');
  try {
    const before = await file.stat();
    assertSourceSize(before.size, filePath);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      assertSourceSize(total, filePath);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino || total !== after.size) {
      throw new Error(`WORKSPACE_CHANGED: ${filePath} changed while reading source`);
    }
    const bytes = Buffer.concat(chunks, total);
    const content = bytes.toString('utf8');
    return {
      snapshot: {
        file: filePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        encoding: 'utf-8',
        offsetUnit: 'utf16',
        lineCount: lineStarts(content).length,
      },
      content,
    };
  } finally {
    await file.close();
  }
}

export function getSourceLineRange(
  snapshot: SourceSnapshot,
  content: string,
  startLine: number,
  endLine: number
): { lineRange: SourceLineRange; ref: SourceRef } {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      startLine < 1 || endLine < startLine || endLine > snapshot.lineCount) {
    throw new Error(`INVALID_SOURCE_RANGE: expected lines 1-${snapshot.lineCount}, received ${startLine}-${endLine}`);
  }
  const starts = lineStarts(content);
  const startOffset = starts[startLine - 1];
  let endOffset = starts[endLine - 1];
  while (endOffset < content.length && content[endOffset] !== '\r' && content[endOffset] !== '\n') endOffset++;
  return {
    lineRange: { startLine, endLine },
    ref: { sha256: snapshot.sha256, startOffset, endOffset },
  };
}

export function sliceSourceSnapshot(snapshot: SourceSnapshot, content: string, ref: SourceRef): string {
  if (!/^[a-f\d]{64}$/i.test(ref.sha256)) throw new Error('INVALID_SOURCE_REF: sha256 must be a 64-character hex digest');
  if (snapshot.sha256 !== ref.sha256) throw new Error(`STALE_SOURCE_REF: ${snapshot.file} changed; map it again`);
  assertSafeOffset(content, ref.startOffset);
  assertSafeOffset(content, ref.endOffset);
  if (ref.endOffset < ref.startOffset) throw new Error('INVALID_SOURCE_REF: endOffset precedes startOffset');
  return content.slice(ref.startOffset, ref.endOffset);
}

export async function readSourceRef(path: string, ref: SourceRef): Promise<string> {
  const { snapshot, content } = await readSourceSnapshot(path);
  return sliceSourceSnapshot(snapshot, content, ref);
}

/** Bound reads even when a file grows between stat and read. */
export async function readSourceFile(path: string): Promise<string> {
  const file = await fs.open(path, 'r');
  try {
    assertSourceSize((await file.stat()).size, path);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead; assertSourceSize(total, path);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { await file.close(); }
}

export function readSourceFileSync(path: string): string {
  assertSourceSize(statSync(path).size, path);
  const content = readFileSync(path, 'utf8');
  assertSourceSize(Buffer.byteLength(content), path);
  return content;
}
