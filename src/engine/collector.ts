import { promises as fs, type Dirent } from 'node:fs';
import ignore, { type Ignore } from 'ignore';
import { findProjectRoot } from './path-resolver';
import { extname, join, relative, resolve, dirname, sep } from 'node:path';
import { NON_DOMAIN_DIRS, detectCodeDomains, isNonDomainFile } from './domains';

export const SUPPORTED_SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs']);
export const SUPPORTED_SFC_EXTENSIONS = new Set(['.vue', '.astro', '.svelte']);
export const SUPPORTED_FRONTEND_EXTENSIONS = new Set([...SUPPORTED_SFC_EXTENSIONS, ...SUPPORTED_SCRIPT_EXTENSIONS]);

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

  // AI Agent Harnesses & Indexer Caches
  '.agents',
  '.gemini',
  '.claude',
  '.codex',
  '.codex-evidence',
  '.codegraph',
  '.opencode',
  'opencode',
  '.strata',
  '.vue-ast',

  // Documentation & Non-Code Folders
  'docs',
  'doc',
  'documentation',

  // Tooling, Scripts & Harness
  'scripts',
  'tools',

  // Test Suites, Fixtures & Mocks (Non-domain test code)
  'tests',
  'test',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'cypress',
  'fixtures',
  'mocks',

  // Logs & Runtime Artifacts
  'logs',
  'tmp',
  'temp',
  'artifacts',
  'benchmarks',
  'benchmark',
]);

export interface CollectOptions {
  excludeDirs?: string[];
  respectIgnoreFiles?: boolean;
  /** Workspace boundary for scoped scans, including nested packages. */
  ignoreRoot?: string;
  /** Include configuration fingerprints while streaming an index scan. */
  includeConfigFiles?: boolean;
  /** Fail rather than silently omit unreadable directories or ignore rules. */
  failOnReadError?: boolean;
  /** Include test suites and test fixture directories */
  includeTests?: boolean;
  /** Include build scripts and tool directories */
  includeScripts?: boolean;
  /** Include documentation directories */
  includeDocs?: boolean;
  /** Filter collection to standard code domain directories only */
  domainOnly?: boolean;
}

export const INDEX_CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', '.gitignore', '.strataignore', 'nuxt.config.mjs', 'next.config.mjs', 'astro.config.mjs']);

/**
 * Loads ignore rules from .strataignore or .gitignore in the target directory.
 */
async function loadIgnoreRules(dirPath: string, failOnReadError = false): Promise<string[]> {
  const rules: string[] = [];
  for (const file of ['.gitignore', '.strataignore']) {
    try {
      rules.push(...(await fs.readFile(join(dirPath, file), 'utf8')).split('\n'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && (failOnReadError || (code !== 'EACCES' && code !== 'EPERM'))) throw err;
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
    const lower = entryName.toLowerCase();
    if (options?.includeTests && (['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'cypress', 'fixtures', 'mocks'].includes(lower))) {
      // Allowed via explicit option
    } else if (options?.includeScripts && (['scripts', 'tools'].includes(lower))) {
      // Allowed via explicit option
    } else if (options?.includeDocs && (['docs', 'doc', 'documentation'].includes(lower))) {
      // Allowed via explicit option
    } else if (IGNORED_DIRS.has(entryName) || IGNORED_DIRS.has(lower)) {
      return true;
    }

    if (entryName.startsWith('.') && entryName !== '.' && entryName !== '..' && !options?.includeConfigFiles) {
      return true;
    }

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
      inherited.push({ base, matcher: ignore().add(await loadIgnoreRules(base, options?.failOnReadError)) });
    }
    if (inherited.length && isIgnored(dirPath, stat.isDirectory(), inherited)) return;
  }
  if (!stat.isDirectory()) { yield dirPath; return; }

  // If domainOnly is requested and dirPath has a standard domain layout,
  // anchor traversal to detected domain directories and root entry files.
  if (options?.domainOnly) {
    const domainRes = await detectCodeDomains(dirPath);
    if (domainRes.isStandardLayout && domainRes.activeDomainRoots.length > 0) {
      const rootEntries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (SUPPORTED_FRONTEND_EXTENSIONS.has(ext)) {
            if (!options?.includeTests && isNonDomainFile(entry.name)) {
              continue;
            }
            yield join(dirPath, entry.name);
          }
        }
      }
      for (const domainRoot of domainRes.activeDomainRoots) {
        yield* walk(domainRoot, inherited);
      }
      return;
    }
  }

  async function* walk(currentDir: string, inherited: IgnoreContext[] = []): AsyncGenerator<string> {
    const contexts = [...inherited];
    if (options?.respectIgnoreFiles !== false) {
      contexts.push({ base: currentDir, matcher: ignore().add(await loadIgnoreRules(currentDir, options?.failOnReadError)) });
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!options?.failOnReadError && (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT')) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dirPath, fullPath).replace(/\\/g, '/');

      if (isExcluded(entry.name, relPath)) continue;
      if (entry.isFile() && options?.includeConfigFiles && INDEX_CONFIG_FILES.has(entry.name)) {
        yield fullPath;
        continue;
      }
      if (isIgnored(fullPath, entry.isDirectory(), contexts)) continue;

      if (entry.isDirectory()) {
        yield* walk(fullPath, contexts);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_FRONTEND_EXTENSIONS.has(ext)) {
          if (!options?.includeTests && isNonDomainFile(entry.name)) {
            continue;
          }
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
