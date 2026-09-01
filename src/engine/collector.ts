import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';

export const SUPPORTED_SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs']);
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.output',
  '.nuxt',
  'coverage',
  '.bun',
]);

/**
 * Recursively collects all supported source files (.vue, .astro, .ts, .tsx, .js, .jsx) within a directory.
 */
export async function collectFiles(dirPath: string): Promise<string[]> {
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return [dirPath];
  }

  const results: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.vue' || ext === '.astro' || SUPPORTED_SCRIPT_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dirPath);
  return results;
}
