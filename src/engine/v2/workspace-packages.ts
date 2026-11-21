import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname, extname } from 'node:path';
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
  if (has('svelte.config.js') || has('svelte.config.ts') || deps['@sveltejs/kit'] || deps.svelte) {
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

/**
 * Resolves a workspace package import (e.g. "@acme/ui" or "@acme/ui/BaseButton.vue")
 * directly to its canonical source file path.
 */
export function resolveWorkspacePackageImport(
  specifier: string,
  packages: readonly WorkspacePackageInfo[]
): string | null {
  const tryFile = (candidate: string): string | null => {
    const exts = ['', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.js', '.jsx'];
    for (const ext of exts) {
      const full = candidate + ext;
      if (existsSync(full) && statSync(full).isFile()) return canonicalizePath(full);
    }
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue']) {
      const idx = join(candidate, `index${ext}`);
      if (existsSync(idx) && statSync(idx).isFile()) return canonicalizePath(idx);
    }
    return null;
  };

  for (const pkg of packages) {
    if (!pkg.name) continue;
    if (specifier === pkg.name) {
      const target = pkg.exportsMap['.'];
      if (target) {
        const hit = tryFile(resolve(pkg.rootPath, target));
        if (hit) return hit;
      }
      return tryFile(join(pkg.rootPath, 'src', 'index'));
    }
    if (specifier.startsWith(`${pkg.name}/`)) {
      const subpath = `./${specifier.slice(pkg.name.length + 1)}`;
      const exact = pkg.exportsMap[subpath];
      if (exact) {
        const hit = tryFile(resolve(pkg.rootPath, exact));
        if (hit) return hit;
      }
      // Wildcard export e.g. "./*": "./src/*"
      for (const [expKey, expVal] of Object.entries(pkg.exportsMap)) {
        if (expKey.endsWith('/*') && expVal.endsWith('/*')) {
          const prefix = expKey.slice(0, -1);
          if (subpath.startsWith(prefix)) {
            const rest = subpath.slice(prefix.length);
            const hit = tryFile(resolve(pkg.rootPath, expVal.slice(0, -1) + rest));
            if (hit) return hit;
          }
        }
      }
      // Fallback: package root or src/
      const direct = tryFile(resolve(pkg.rootPath, subpath)) ?? tryFile(resolve(pkg.rootPath, 'src', subpath.slice(2)));
      if (direct) return direct;
    }
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
 */
export function resolveRelativeModuleFile(containingFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(containingFile), specifier);
  const exts = extname(base) ? [''] : ['', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.js', '.jsx'];
  for (const ext of exts) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return canonicalizePath(candidate);
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue']) {
    const idx = join(base, `index${ext}`);
    if (existsSync(idx) && statSync(idx).isFile()) return canonicalizePath(idx);
  }
  return null;
}
