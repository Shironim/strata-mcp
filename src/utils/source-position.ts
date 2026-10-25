import type { SourcePosition } from '../types';

export function lineStarts(content: string): number[] {
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

export function assertSafeOffset(content: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) {
    throw new Error('INVALID_SOURCE_REF: offset is outside the source snapshot');
  }
  if (offset > 0 && offset < content.length) {
    const before = content.charCodeAt(offset - 1);
    const at = content.charCodeAt(offset);
    if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) {
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

