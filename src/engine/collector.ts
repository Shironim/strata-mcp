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
  '.toolbench',
  '.vue-ast',

  // Documentation & Non-Code Folders
  'docs',
  'doc',
  'documentation',

  // Tooling, Scripts & Harness
  'scripts',

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

export interface ExcludedDirectoryReport {
  path: string;
  reason: 'default-ignore' | 'hidden' | 'custom-exclude' | 'ignore-file' | 'read-error';
}

export interface CollectFilesReport {
  files: string[];
  excludedDirs: ExcludedDirectoryReport[];
}

export const INDEX_CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', '.gitignore', '.strataignore', 'nuxt.config.mjs', 'next.config.mjs', 'astro.config.mjs']);

const DOC_DIR_NAMES = new Set(['docs', 'doc', 'documentation']);
const CODE_DOMAIN_PARENTS = new Set([
  'app',
  'src',
  'pages',
  'components',
  'composables',
  'layouts',
  'middleware',
  'plugins',
  'server',
  'routes',
  'views',
  'api',
]);

/**
 * Returns true when a `docs`/`doc`/`documentation` folder is nested inside an
 * application source/routing directory (e.g. `app/pages/docs`, `server/api/docs`)
 * rather than being a standalone repository documentation folder.
 */
function isCodeDomainDocsDir(scanRoot: string, relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (CODE_DOMAIN_PARENTS.has(parts[i]!.toLowerCase())) {
      return true;
    }
  }
  const scanParts = scanRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = scanParts.length - 1; i >= Math.max(0, scanParts.length - 3); i--) {
    if (CODE_DOMAIN_PARENTS.has(scanParts[i]!.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the file is a project configuration file affecting build,
 * path aliases (e.g. tsconfig.*.json, jsconfig.*.json), or framework setup.
 */
export function isConfigFile(fileName: string): boolean {
  if (INDEX_CONFIG_FILES.has(fileName)) return true;
  if (/^(tsconfig|jsconfig)(\..+)?\.json$/i.test(fileName)) return true;
  if (/^(nuxt|next|astro|svelte|vite)\.config\.(ts|js|mjs|cjs|mts)$/i.test(fileName)) return true;
  return false;
}

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

async function* iterateFilesInternal(
  dirPath: string,
  options?: CollectOptions,
  excludedDirs?: ExcludedDirectoryReport[]
): AsyncGenerator<string> {
  dirPath = resolve(dirPath);
  const stat = await fs.stat(dirPath);

  const customExcludeSet = new Set(
    (options?.excludeDirs ?? [])
      .map((d) => d.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
      .filter(Boolean)
  );

  function getExclusionReason(entryName: string, relativePath: string): ExcludedDirectoryReport['reason'] | null {
    const lower = entryName.toLowerCase();
    for (const pattern of customExcludeSet) {
      if (entryName === pattern || relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return 'custom-exclude';
    }
    if (options?.includeTests && (['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'cypress', 'fixtures', 'mocks'].includes(lower))) {
      // Allowed via explicit option
    } else if (options?.includeScripts && lower === 'scripts') {
      // Allowed via explicit option
    } else if (DOC_DIR_NAMES.has(lower) && (options?.includeDocs || isCodeDomainDocsDir(dirPath, relativePath))) {
      // Allowed via explicit option or when nested inside an application code/routing directory
    } else if (IGNORED_DIRS.has(entryName) || IGNORED_DIRS.has(lower)) {
      return entryName.startsWith('.') ? 'hidden' : 'default-ignore';
    }

    if (entryName.startsWith('.') && entryName !== '.' && entryName !== '..' && !options?.includeConfigFiles) {
      return 'hidden';
    }

    return null;
  }

  type IgnoreContext = { base: string; matcher: Ignore };
  function hasActiveIgnoreRules(rules: string[]): boolean {
    for (const r of rules) {
      const t = r.trim();
      if (t && !t.startsWith('#')) return true;
    }
    return false;
  }
  function isIgnored(fullPath: string, directory: boolean, contexts: IgnoreContext[]): boolean {
    if (contexts.length === 0) return false;
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
      const rules = await loadIgnoreRules(base, options?.failOnReadError);
      if (hasActiveIgnoreRules(rules)) {
        inherited.push({ base, matcher: ignore().add(rules) });
      }
    }
    if (inherited.length && isIgnored(dirPath, stat.isDirectory(), inherited)) {
      if (stat.isDirectory()) excludedDirs?.push({ path: '.', reason: 'ignore-file' });
      return;
    }
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
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!options?.failOnReadError && (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT')) {
        const relDir = relative(dirPath, currentDir).replace(/\\/g, '/') || '.';
        excludedDirs?.push({ path: relDir, reason: 'read-error' });
        return;
      }
      throw err;
    }

    let contexts = inherited;
    if (options?.respectIgnoreFiles !== false) {
      let hasIgnoreFile = false;
      for (const entry of entries) {
        if ((entry.name === '.gitignore' || entry.name === '.strataignore') && entry.isFile()) {
          hasIgnoreFile = true;
          break;
        }
      }
      if (hasIgnoreFile) {
        const rules = await loadIgnoreRules(currentDir, options?.failOnReadError);
        if (hasActiveIgnoreRules(rules)) {
          contexts = [...inherited, { base: currentDir, matcher: ignore().add(rules) }];
        }
      }
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dirPath, fullPath).replace(/\\/g, '/');
      const exclusionReason = getExclusionReason(entry.name, relPath);

      if (exclusionReason) {
        if (entry.isDirectory()) excludedDirs?.push({ path: relPath || entry.name, reason: exclusionReason });
        continue;
      }
      if (entry.isFile() && options?.includeConfigFiles && isConfigFile(entry.name)) {
        yield fullPath;
        continue;
      }
      if (isIgnored(fullPath, entry.isDirectory(), contexts)) {
        if (entry.isDirectory()) excludedDirs?.push({ path: relPath || entry.name, reason: 'ignore-file' });
        continue;
      }

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

/**
 * Recursively collects all supported source files (.vue, .astro, .ts, .tsx, .js, .jsx) within a directory.
 */
export async function* iterateFiles(
  dirPath: string,
  options?: CollectOptions
): AsyncGenerator<string> {
  yield* iterateFilesInternal(dirPath, options);
}

export async function collectFiles(dirPath: string, options?: CollectOptions): Promise<string[]> {
  const files: string[] = [];
  for await (const file of iterateFiles(dirPath, options)) files.push(file);
  return files;
}

export async function collectFilesWithReport(dirPath: string, options?: CollectOptions): Promise<CollectFilesReport> {
  const files: string[] = [];
  const rawExcluded: ExcludedDirectoryReport[] = [];
  for await (const file of iterateFilesInternal(dirPath, options, rawExcluded)) files.push(file);
  const seen = new Map<string, ExcludedDirectoryReport>();
  for (const item of rawExcluded) {
    if (!seen.has(item.path)) seen.set(item.path, item);
  }
  const excludedDirs = Array.from(seen.values()).sort((a, b) => a.path.localeCompare(b.path));
  return { files, excludedDirs };
}
