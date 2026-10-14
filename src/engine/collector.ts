import { promises as fs } from 'node:fs';
import ignore, { type Ignore } from 'ignore';
import { findProjectRoot } from './path-resolver';
import { extname, join, relative, resolve, dirname, sep } from 'node:path';

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
  '.codex-evidence',
  '.strata',
  '.vue-ast',
  '.gemini',
  '.cursor',
  '.continue',
]);

export interface CollectOptions {
  excludeDirs?: string[];
  respectIgnoreFiles?: boolean;
  /** Workspace boundary for scoped scans, including nested packages. */
  ignoreRoot?: string;
  /** Include configuration fingerprints while streaming an index scan. */
  includeConfigFiles?: boolean;
}

/**
 * Loads ignore rules from .strataignore or .gitignore in the target directory.
 */
async function loadIgnoreRules(dirPath: string): Promise<string[]> {
  const rules: string[] = [];
  for (const file of ['.gitignore', '.strataignore']) {
    try {
      rules.push(...(await fs.readFile(join(dirPath, file), 'utf8')).split('\n'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return rules;
}

export async function loadIgnorePatterns(dirPath: string): Promise<Set<string>> {
  return new Set((await loadIgnoreRules(dirPath)).filter(line => line && !line.startsWith('#')));
}

/**
 * Recursively collects all supported source files (.vue, .astro, .ts, .tsx, .js, .jsx) within a directory.
 */
export async function* iterateFiles(
  dirPath: string,
  options?: CollectOptions
): AsyncGenerator<string> {
  dirPath = resolve(dirPath);
  const stat = await fs.stat(dirPath);

  const customExcludeSet = new Set(
    (options?.excludeDirs ?? [])
      .map((d) => d.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
      .filter(Boolean)
  );

  function isExcluded(entryName: string, relativePath: string): boolean {
    if (IGNORED_DIRS.has(entryName)) return true;
    for (const pattern of customExcludeSet) {
      if (entryName === pattern || relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return true;
    }
    return false;
  }

  type IgnoreContext = { base: string; matcher: Ignore };
  function isIgnored(fullPath: string, directory: boolean, contexts: IgnoreContext[]): boolean {
    let ignored = false;
    for (const { base, matcher } of contexts) {
      const path = relative(base, fullPath).replace(/\\/g, '/') + (directory ? '/' : '');
      const result = matcher.test(path);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  const inherited: IgnoreContext[] = [];
  if (options?.respectIgnoreFiles !== false) {
    const root = options?.ignoreRoot ? resolve(options.ignoreRoot) : findProjectRoot(dirPath);
    const ancestors: string[] = [];
    let parent = dirname(dirPath);
    while (dirPath !== root && (parent === root || parent.startsWith(root + sep))) {
      ancestors.unshift(parent);
      if (parent === root) break;
      parent = dirname(parent);
    }
    for (const base of ancestors) {
      if (inherited.length && isIgnored(base, true, inherited)) return;
      inherited.push({ base, matcher: ignore().add(await loadIgnoreRules(base)) });
    }
    if (inherited.length && isIgnored(dirPath, stat.isDirectory(), inherited)) return;
  }
  if (!stat.isDirectory()) { yield dirPath; return; }

  async function* walk(currentDir: string, inherited: IgnoreContext[] = []): AsyncGenerator<string> {
    const contexts = [...inherited];
    if (options?.respectIgnoreFiles !== false) {
      contexts.push({ base: currentDir, matcher: ignore().add(await loadIgnoreRules(currentDir)) });
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dirPath, fullPath).replace(/\\/g, '/');

      if (isExcluded(entry.name, relPath)) continue;
      if (entry.isFile() && options?.includeConfigFiles && ['package.json', 'tsconfig.json', 'jsconfig.json', '.gitignore', '.strataignore'].includes(entry.name)) {
        yield fullPath;
        continue;
      }
      if (isIgnored(fullPath, entry.isDirectory(), contexts)) continue;

      if (entry.isDirectory()) {
        yield* walk(fullPath, contexts);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.vue' || ext === '.astro' || SUPPORTED_SCRIPT_EXTENSIONS.has(ext)) {
          yield fullPath;
        }
      }
    }
  }

  yield* walk(dirPath, inherited);
}

export async function collectFiles(dirPath: string, options?: CollectOptions): Promise<string[]> {
  const files: string[] = [];
  for await (const file of iterateFiles(dirPath, options)) files.push(file);
  return files;
}
