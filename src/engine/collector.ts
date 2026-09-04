import { promises as fs } from 'node:fs';
import { extname, join, relative } from 'node:path';

export const SUPPORTED_SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs']);

export const IGNORED_DIRS = new Set([
  // Version Control & IDEs
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.fleet',

  // Package Managers & Dependencies
  'node_modules',
  'vendor',
  '.bundle',
  'deps',

  // Frontend Virtual & Output
  'dist',
  'build',
  '.output',
  '.nuxt',
  '.next',
  '.astro',
  '.svelte-kit',
  'out',
  '.open-next',

  // Backend & Fullstack Hybrid Artifacts
  'storage',
  'public',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '_build',
  'bin',
  'pkg',

  // Cache, Bundlers & Test Tooling
  'coverage',
  '.nyc_output',
  '.bun',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'playwright-report',
  'test-results',
  '.playwright',
  'storybook-static',

  // AI & Indexer Caches
  '.codegraph',
  '.gemini',
  '.cursor',
  '.continue',
]);

export interface CollectOptions {
  excludeDirs?: string[];
  respectIgnoreFiles?: boolean;
}

/**
 * Loads ignore rules from .strataignore or .gitignore in the target directory.
 */
export async function loadIgnorePatterns(dirPath: string): Promise<Set<string>> {
  const patterns = new Set<string>();
  const candidateFiles = ['.strataignore', '.gitignore'];

  for (const file of candidateFiles) {
    const ignoreFilePath = join(dirPath, file);
    try {
      const content = await fs.readFile(ignoreFilePath, 'utf8');
      const lines = content.split('\n');
      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const clean = line.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
        if (clean) {
          patterns.add(clean);
        }
      }
    } catch {
      // Ignore if file doesn't exist or is not readable
    }
  }

  return patterns;
}

/**
 * Recursively collects all supported source files (.vue, .astro, .ts, .tsx, .js, .jsx) within a directory.
 */
export async function collectFiles(
  dirPath: string,
  options?: CollectOptions
): Promise<string[]> {
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return [dirPath];
  }

  const results: string[] = [];
  const customExcludeSet = new Set(
    (options?.excludeDirs ?? [])
      .map((d) => d.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
      .filter(Boolean)
  );

  let fileIgnoreSet = new Set<string>();
  if (options?.respectIgnoreFiles !== false) {
    fileIgnoreSet = await loadIgnorePatterns(dirPath);
  }

  function isIgnored(entryName: string, relativePath: string): boolean {
    if (IGNORED_DIRS.has(entryName)) return true;
    if (customExcludeSet.has(entryName) || customExcludeSet.has(relativePath)) return true;
    if (fileIgnoreSet.has(entryName) || fileIgnoreSet.has(relativePath)) return true;

    // Check if relative path starts with any excluded prefix
    for (const pattern of customExcludeSet) {
      if (relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return true;
    }
    for (const pattern of fileIgnoreSet) {
      if (relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return true;
    }

    return false;
  }

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dirPath, fullPath).replace(/\\/g, '/');

      if (isIgnored(entry.name, relPath)) continue;

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
