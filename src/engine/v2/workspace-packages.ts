import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname, extname } from 'node:path';
import ts from 'typescript';
import { canonicalizePath } from '../path-resolver';
import type { FrontendFrameworkId } from '../../plugins/types';

export interface WorkspacePackageInfo {
  packageKey: string;            // e.g. "apps/web", "packages/ui", "."
  name: string | null;           // package.json "name"
  rootPath: string;              // canonical absolute path
  tsconfigPath: string | null;   // nearest tsconfig.json / jsconfig.json
  framework: FrontendFrameworkId | 'unknown';
  router: string;
  exportsMap: Record<string, string>; // subpath (".", "./types") -> relative source file
  manifestHash: string;
  workspaceDeps: string[];       // names of other workspace packages referenced
  aliasBaseUrl?: string;         // resolved tsconfig baseUrl (or pkg.rootPath)
  pathAliases?: Record<string, string[]>; // tsconfig/jsconfig compilerOptions.paths
}

function readJsonSafe(filePath: string): Record<string, any> | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePnpmWorkspacePatterns(rootDir: string): string[] {
  const yamlPath = join(rootDir, 'pnpm-workspace.yaml');
  if (!existsSync(yamlPath)) return [];
  try {
    const raw = readFileSync(yamlPath, 'utf8');
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^packages\s*:/.test(trimmed)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        if (/^[a-zA-Z0-9_-]+\s*:/.test(trimmed)) break;
        const m = /^-\s*['"]?([^'"]+)['"]?$/.exec(trimmed);
        if (m && !m[1].startsWith('!')) {
          patterns.push(m[1].replace(/\/+$/, ''));
        }
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function parsePackageJsonWorkspaces(rootDir: string): string[] {
  const pkg = readJsonSafe(join(rootDir, 'package.json'));
  if (!pkg?.workspaces) return [];
  const list = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg.workspaces.packages)
      ? pkg.workspaces.packages
      : [];
  return list
    .filter((item: unknown): item is string => typeof item === 'string' && !item.startsWith('!'))
    .map((item: string) => item.replace(/\/+$/, ''));
}

function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
  const results: string[] = [];
  if (!pattern.includes('*')) {
    const full = resolve(rootDir, pattern);
    if (existsSync(join(full, 'package.json'))) results.push(full);
    return results;
  }

  // Handle standard "dir/*" and "dir/**" patterns
  const isDeep = pattern.endsWith('/**');
  const baseRel = pattern.replace(/\/?\*\*?$/, '');
  const baseDir = resolve(rootDir, baseRel);
  if (!existsSync(baseDir)) return results;

  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.strata') {
        continue;
      }
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (existsSync(join(full, 'package.json'))) {
        results.push(full);
      } else if (isDeep && depth < 4) {
        walk(full, depth + 1);
      }
    }
  };

  walk(baseDir, 0);
  return results;
}

function normalizeExportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ['source', 'development', 'import', 'types', 'default']) {
      const candidate = normalizeExportTarget(obj[key]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function extractExportsMap(pkg: Record<string, any> | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!pkg) return map;

  if (typeof pkg.exports === 'string') {
    map['.'] = pkg.exports;
  } else if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const resolved = normalizeExportTarget(target);
      if (resolved) map[subpath] = resolved;
    }
  }

  if (!map['.']) {
    const fallback = pkg.source || pkg.module || pkg.main;
    if (typeof fallback === 'string') map['.'] = fallback;
  }
  return map;
}

function hasFileWithExtension(dir: string, targetExt: string, maxDepth = 3): boolean {
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.strata']);
  const walk = (currentDir: string, depth: number): boolean => {
    if (depth > maxDepth) return false;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name) === targetExt) {
        return true;
      }
      if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
        if (walk(join(currentDir, entry.name), depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

function detectPackageFrameworkAndRouter(
  pkgRoot: string,
  pkg: Record<string, any> | null
): { framework: FrontendFrameworkId | 'unknown'; router: string } {
  const deps: Record<string, unknown> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  const has = (file: string) => existsSync(join(pkgRoot, file));

  if (has('nuxt.config.ts') || has('nuxt.config.js') || has('nuxt.config.mjs') || deps.nuxt || deps.nuxt3) {
    return { framework: 'nuxt', router: 'nuxt' };
  }
  if (has('next.config.ts') || has('next.config.mjs') || has('next.config.js') || deps.next) {
    const hasApp = existsSync(join(pkgRoot, 'app')) || existsSync(join(pkgRoot, 'src', 'app'));
    return { framework: 'next', router: hasApp ? 'next-app' : 'next-pages' };
  }
  if (has('astro.config.mjs') || has('astro.config.ts') || has('astro.config.js') || deps.astro) {
    return { framework: 'astro', router: 'astro' };
  }
  if (
    has('svelte.config.js') ||
    has('svelte.config.ts') ||
    has('svelte.config.mjs') ||
    deps['@sveltejs/kit'] ||
    (deps.svelte && hasFileWithExtension(pkgRoot, '.svelte'))
  ) {
    return { framework: 'svelte', router: deps['@sveltejs/kit'] ? 'sveltekit' : 'none' };
  }
  if (deps.vue) {
    return { framework: 'vue', router: deps['vue-router'] ? 'vue-router' : 'none' };
  }
  if (deps.react) {
    return { framework: 'react', router: deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none' };
  }
  return { framework: 'ts', router: 'none' };
}

function findPackageTsconfig(pkgRoot: string): string | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = join(pkgRoot, name);
    if (existsSync(candidate)) return canonicalizePath(candidate);
  }
  return null;
}

function extractTsconfigAliases(
  pkgRoot: string,
  tsconfigPath: string | null
): { aliasBaseUrl?: string; pathAliases?: Record<string, string[]> } {
  if (!tsconfigPath || !existsSync(tsconfigPath)) return {};
  try {
    const readRes = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (readRes.error || !readRes.config) return {};
    const parsed = ts.parseJsonConfigFileContent(
      readRes.config,
      ts.sys,
      dirname(tsconfigPath),
      undefined,
      tsconfigPath
    );
    const paths = parsed.options.paths;
    const baseUrl = parsed.options.baseUrl
      ? canonicalizePath(resolve(dirname(tsconfigPath), parsed.options.baseUrl))
      : dirname(tsconfigPath);
    if (!paths || Object.keys(paths).length === 0) {
      return parsed.options.baseUrl ? { aliasBaseUrl: baseUrl } : {};
    }
    const cleanPaths: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(paths)) {
      if (Array.isArray(v)) cleanPaths[k] = v.filter((x): x is string => typeof x === 'string');
    }
    return {
      aliasBaseUrl: baseUrl || pkgRoot,
      pathAliases: cleanPaths,
    };
  } catch {
    return {};
  }
}

function buildPackageInfo(workspaceRoot: string, pkgRoot: string): WorkspacePackageInfo {
  const canonicalPkgRoot = canonicalizePath(pkgRoot);
  const rel = relative(workspaceRoot, canonicalPkgRoot).replace(/\\/g, '/');
  const packageKey = rel === '' ? '.' : rel;

  const pkgPath = join(canonicalPkgRoot, 'package.json');
  const rawPkg = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : '';
  const pkg = rawPkg ? readJsonSafe(pkgPath) : null;
  const tsconfigPath = findPackageTsconfig(canonicalPkgRoot);
  const rawTsconfig = tsconfigPath && existsSync(tsconfigPath) ? readFileSync(tsconfigPath, 'utf8') : '';

  const manifestHash = createHash('sha256')
    .update(rawPkg)
    .update('\0')
    .update(rawTsconfig)
    .digest('hex');

  const { framework, router } = detectPackageFrameworkAndRouter(canonicalPkgRoot, pkg);
  const exportsMap = extractExportsMap(pkg);
  const { aliasBaseUrl, pathAliases } = extractTsconfigAliases(canonicalPkgRoot, tsconfigPath);

  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const workspaceDeps = Object.keys(allDeps);

  return {
    packageKey,
    name: typeof pkg?.name === 'string' ? pkg.name : null,
    rootPath: canonicalPkgRoot,
    tsconfigPath,
    framework,
    router,
    exportsMap,
    manifestHash,
    workspaceDeps,
    ...(aliasBaseUrl ? { aliasBaseUrl } : {}),
    ...(pathAliases ? { pathAliases } : {}),
  };
}

const FRONTEND_CONFIG_FILES = [
  'nuxt.config.ts',
  'nuxt.config.js',
  'nuxt.config.mjs',
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.js',
  'svelte.config.js',
  'svelte.config.ts',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
] as const;

function hasFrontendProjectMarkers(dir: string): boolean {
  if (FRONTEND_CONFIG_FILES.some((cfg) => existsSync(join(dir, cfg)))) {
    return true;
  }
  const pkg = readJsonSafe(join(dir, 'package.json'));
  if (!pkg) return false;
  const deps: Record<string, unknown> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  return Boolean(
    deps.vue ||
      deps.nuxt ||
      deps.nuxt3 ||
      deps.react ||
      deps.next ||
      deps.svelte ||
      deps['@sveltejs/kit'] ||
      deps.astro
  );
}

/**
 * Shallow scan (depth <= 2) for monolith repositories where frontend and backend
 * live in separate subdirectories without a root workspace manifest (e.g. backend/ + frontend/).
 */
function discoverMonolithSubprojects(absRoot: string): string[] {
  const found: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.strata',
    '.next',
    '.nuxt',
    '.output',
    'vendor',
    'target',
    'coverage',
    '__pycache__',
  ]);

  const scan = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (existsSync(join(full, 'package.json')) && hasFrontendProjectMarkers(full)) {
        found.push(canonicalizePath(full));
      } else if (depth < 2) {
        scan(full, depth + 1);
      }
    }
  };

  scan(absRoot, 1);
  return found;
}

/**
 * Discovers frontend packages across all supported repository layouts:
 * - Monorepo (pnpm-workspace.yaml or package.json#workspaces)
 * - Monolith with separate frontend subdirectory (e.g. backend/ + frontend/ or web/)
 * - Single-repo frontend or fullstack JS/TS application (Next.js, Nuxt, SvelteKit, Astro, Vue, React)
 */
export function discoverWorkspacePackages(workspaceRoot: string): WorkspacePackageInfo[] {
  const absRoot = canonicalizePath(workspaceRoot);
  const patterns = new Set<string>([
    ...parsePnpmWorkspacePatterns(absRoot),
    ...parsePackageJsonWorkspaces(absRoot),
  ]);

  const discoveredRoots = new Set<string>();
  for (const pattern of patterns) {
    for (const pkgRoot of expandWorkspacePattern(absRoot, pattern)) {
      discoveredRoots.add(canonicalizePath(pkgRoot));
    }
  }

  // If no workspace manifest is present, check for monolith frontend subdirectories
  if (discoveredRoots.size === 0) {
    const rootIsFrontend = hasFrontendProjectMarkers(absRoot);
    if (rootIsFrontend) {
      discoveredRoots.add(absRoot);
    } else {
      for (const sub of discoverMonolithSubprojects(absRoot)) {
        discoveredRoots.add(sub);
      }
    }
  }

  if (discoveredRoots.size === 0) {
    discoveredRoots.add(absRoot);
  }

  const packages = [...discoveredRoots]
    .sort()
    .map((pkgRoot) => buildPackageInfo(absRoot, pkgRoot));

  // Narrow workspaceDeps to actual internal workspace package names
  const workspaceNames = new Set(packages.map((p) => p.name).filter((n): n is string => Boolean(n)));
  for (const pkg of packages) {
    pkg.workspaceDeps = pkg.workspaceDeps.filter((dep) => workspaceNames.has(dep));
  }

  return packages;
}

const RESOLVE_FILE_EXTS = ['', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.js', '.jsx'] as const;
const RESOLVE_INDEX_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.vue'] as const;

function tryResolveCandidateFile(candidate: string, fileSet?: ReadonlySet<string>): string | null {
  const canonBase = canonicalizePath(candidate);
  const exts = extname(canonBase) ? ([''] as const) : RESOLVE_FILE_EXTS;
  if (fileSet) {
    for (const ext of exts) {
      const full = canonBase + ext;
      if (fileSet.has(full)) return full;
    }
    for (const ext of RESOLVE_INDEX_EXTS) {
      const idx = join(canonBase, `index${ext}`);
      if (fileSet.has(idx)) return idx;
    }
    return null;
  }
  for (const ext of exts) {
    const full = canonBase + ext;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  for (const ext of RESOLVE_INDEX_EXTS) {
    const idx = join(canonBase, `index${ext}`);
    if (existsSync(idx) && statSync(idx).isFile()) return idx;
  }
  return null;
}

const packageByNameCache = new WeakMap<
  readonly WorkspacePackageInfo[],
  Map<string, WorkspacePackageInfo>
>();

function getPackageByNameMap(
  packages: readonly WorkspacePackageInfo[]
): Map<string, WorkspacePackageInfo> {
  let map = packageByNameCache.get(packages);
  if (!map) {
    map = new Map<string, WorkspacePackageInfo>();
    for (const pkg of packages) {
      if (pkg.name && !map.has(pkg.name)) {
        map.set(pkg.name, pkg);
      }
    }
    packageByNameCache.set(packages, map);
  }
  return map;
}

function extractPackageNameFromSpecifier(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('@')) {
    const firstSlash = specifier.indexOf('/');
    if (firstSlash === -1) return null;
    const secondSlash = specifier.indexOf('/', firstSlash + 1);
    return secondSlash === -1 ? specifier : specifier.slice(0, secondSlash);
  }
  const firstSlash = specifier.indexOf('/');
  return firstSlash === -1 ? specifier : specifier.slice(0, firstSlash);
}

/**
 * Resolves a workspace package import (e.g. "@acme/ui" or "@acme/ui/BaseButton.vue")
 * directly to its canonical source file path.
 * When `fileSet` is provided, uses O(1) in-memory Set lookups instead of filesystem stat syscalls.
 */
export function resolveWorkspacePackageImport(
  specifier: string,
  packages: readonly WorkspacePackageInfo[],
  fileSet?: ReadonlySet<string>
): string | null {
  const pkgName = extractPackageNameFromSpecifier(specifier);
  if (!pkgName) return null;

  const pkg = getPackageByNameMap(packages).get(pkgName);
  if (!pkg || !pkg.name) return null;

  if (specifier === pkg.name) {
    const target = pkg.exportsMap['.'];
    if (target) {
      const hit = tryResolveCandidateFile(resolve(pkg.rootPath, target), fileSet);
      if (hit) return hit;
    }
    return tryResolveCandidateFile(join(pkg.rootPath, 'src', 'index'), fileSet);
  }
  if (specifier.startsWith(`${pkg.name}/`)) {
    const subpath = `./${specifier.slice(pkg.name.length + 1)}`;
    const exact = pkg.exportsMap[subpath];
    if (exact) {
      const hit = tryResolveCandidateFile(resolve(pkg.rootPath, exact), fileSet);
      if (hit) return hit;
    }
    // Wildcard export e.g. "./*": "./src/*"
    for (const [expKey, expVal] of Object.entries(pkg.exportsMap)) {
      if (expKey.endsWith('/*') && expVal.endsWith('/*')) {
        const prefix = expKey.slice(0, -1);
        if (subpath.startsWith(prefix)) {
          const rest = subpath.slice(prefix.length);
          const hit = tryResolveCandidateFile(resolve(pkg.rootPath, expVal.slice(0, -1) + rest), fileSet);
          if (hit) return hit;
        }
      }
    }
    // Fallback: package root or src/
    const direct =
      tryResolveCandidateFile(resolve(pkg.rootPath, subpath), fileSet) ??
      tryResolveCandidateFile(resolve(pkg.rootPath, 'src', subpath.slice(2)), fileSet);
    if (direct) return direct;
  }
  return null;
}

/**
 * Finds the most specific owning package for a file path (longest rootPath match).
 */
export function matchOwningPackage(
  filePath: string,
  packages: readonly WorkspacePackageInfo[]
): WorkspacePackageInfo | null {
  const abs = canonicalizePath(filePath);
  let best: WorkspacePackageInfo | null = null;
  for (const pkg of packages) {
    if (abs === pkg.rootPath || abs.startsWith(pkg.rootPath + '/') || abs.startsWith(pkg.rootPath + '\\')) {
      if (!best || pkg.rootPath.length > best.rootPath.length) {
        best = pkg;
      }
    }
  }
  return best;
}

/**
 * Resolves a relative import specifier from `containingFile` to a canonical file path.
 * When `fileSet` is provided, uses O(1) in-memory Set lookups instead of filesystem stat syscalls.
 */
export function resolveRelativeModuleFile(
  containingFile: string,
  specifier: string,
  fileSet?: ReadonlySet<string>
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(containingFile), specifier);
  return tryResolveCandidateFile(base, fileSet);
}

/**
 * SSOT alias resolver for tsconfig/jsconfig `compilerOptions.paths` and common bundler
 * prefixes (`@/...`, `~/...`) within a workspace package.
 * Handles extensionless imports, `.vue`/`.svelte`/`.astro`/`.ts`/`.tsx` targets, and `/index.*`.
 */
export function resolvePackageAliasImport(
  specifier: string,
  pkg: WorkspacePackageInfo,
  fileSet?: ReadonlySet<string>
): string | null {
  const base = pkg.aliasBaseUrl ?? pkg.rootPath;

  if (pkg.pathAliases) {
    for (const [pattern, targets] of Object.entries(pkg.pathAliases)) {
      if (pattern === specifier) {
        for (const t of targets) {
          const hit = tryResolveCandidateFile(resolve(base, t), fileSet);
          if (hit) return hit;
        }
      } else if (pattern.includes('*')) {
        const starIdx = pattern.indexOf('*');
        const prefix = pattern.slice(0, starIdx);
        const suffix = pattern.slice(starIdx + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
          const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
          for (const t of targets) {
            const candidate = t.includes('*') ? t.replace('*', matched) : t + matched;
            const hit = tryResolveCandidateFile(resolve(base, candidate), fileSet);
            if (hit) return hit;
          }
        }
      }
    }
  }

  // Fallback for Vite/Webpack `@/` or `~/` aliases when tsconfig paths are absent or incomplete
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rest = specifier.slice(2);
    const candidates = [
      resolve(pkg.rootPath, 'src', rest),
      resolve(pkg.rootPath, rest),
    ];
    for (const candidate of candidates) {
      const hit = tryResolveCandidateFile(candidate, fileSet);
      if (hit) return hit;
    }
  }

  return null;
}
