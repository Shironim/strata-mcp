import { promises as fs, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SourceLineRange, SourcePosition, SourceRef, SourceSnapshot } from '../types';

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function assertSourceSize(bytes: number, path: string): void {
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`SOURCE_TOO_LARGE: ${path} exceeds 8 MiB`);
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\r') {
      if (content[i + 1] === '\n') i++;
      starts.push(i + 1);
    } else if (content[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function assertSafeOffset(content: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) {
    throw new Error('INVALID_SOURCE_REF: offset is outside the source snapshot');
  }
  if (offset > 0 && offset < content.length) {
    const before = content.charCodeAt(offset - 1);
    const after = content.charCodeAt(offset);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      throw new Error('INVALID_SOURCE_REF: offset splits a Unicode surrogate pair');
    }
  }
}

export function getSourcePosition(content: string, offset: number): SourcePosition {
  assertSafeOffset(content, offset);
  const starts = lineStarts(content);
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - starts[low] + 1, offset };
}

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
