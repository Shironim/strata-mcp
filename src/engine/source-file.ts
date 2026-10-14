import { promises as fs, statSync, readFileSync } from 'node:fs';

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function assertSourceSize(bytes: number, path: string): void {
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`SOURCE_TOO_LARGE: ${path} exceeds 8 MiB`);
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
