import { readSourceFile, readSourceFileSync } from './source-file';
import { statSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** User-supplied alias map: `{ "@/*": "resources/js/*", "@/": "src/" }`. */
export type AliasMap = Record<string, string>;

/**
 * Resolves import specifiers against a set of configured path aliases.
 *
 * Supported alias shapes (the same rule applies to auto-detected tsconfig paths
 * and to explicit `alias_map` overrides):
 * - `"@/*"`  -> wildcard: the `*` in the alias is captured and reinserted into the target.
 * - `"@/"`   -> prefix: any specifier starting with `@/` maps into the target directory.
 * - `"@"`    -> exact: only the exact specifier `"@"` matches (avoids over-matching `@scope/pkg`).
 */
export interface AliasConfig {
  isAlias(specifier: string): boolean;
  resolve(specifier: string): string | null;
}

type AliasMatchKind = 'wildcard' | 'prefix' | 'exact';

interface AliasEntry {
  matchKind: AliasMatchKind;
  aliasBefore: string;
  aliasAfter: string;
  targetBefore: string;
  targetAfter: string;
}

function buildAliasEntry(alias: string, target: string): AliasEntry {
  const aliasStar = alias.indexOf('*');
  const targetStar = target.indexOf('*');

  if (aliasStar >= 0) {
    return {
      matchKind: 'wildcard',
      aliasBefore: alias.slice(0, aliasStar),
      aliasAfter: alias.slice(aliasStar + 1),
      targetBefore: targetStar >= 0 ? target.slice(0, targetStar) : target,
      targetAfter: targetStar >= 0 ? target.slice(targetStar + 1) : '',
    };
  }

  if (alias.endsWith('/')) {
    return {
      matchKind: 'prefix',
      aliasBefore: alias,
      aliasAfter: '',
      targetBefore: target,
      targetAfter: '',
    };
  }

  return {
    matchKind: 'exact',
    aliasBefore: alias,
    aliasAfter: '',
    targetBefore: target,
    targetAfter: '',
  };
}

/**
 * Returns the captured remainder for a matching specifier, or `null` when it does not match.
 */
function matchAliasEntry(entry: AliasEntry, specifier: string): string | null {
  if (entry.matchKind === 'wildcard') {
    const prefixMatches = specifier.startsWith(entry.aliasBefore);
    const suffixMatches = specifier.endsWith(entry.aliasAfter);
    const longEnough = specifier.length >= entry.aliasBefore.length + entry.aliasAfter.length;

    if (!prefixMatches || !suffixMatches || !longEnough) return null;
    return specifier.slice(entry.aliasBefore.length, specifier.length - entry.aliasAfter.length);
  }

  if (entry.matchKind === 'prefix') {
    return specifier.startsWith(entry.aliasBefore)
      ? specifier.slice(entry.aliasBefore.length)
      : null;
  }

  return specifier === entry.aliasBefore ? '' : null;
}

function createAliasConfigFromEntries(entries: AliasEntry[], baseDir: string): AliasConfig {
  return {
    isAlias(specifier: string): boolean {
      return entries.some((entry) => matchAliasEntry(entry, specifier) !== null);
    },

    resolve(specifier: string): string | null {
      for (const entry of entries) {
        const remainder = matchAliasEntry(entry, specifier);
        if (remainder === null) continue;
        return resolve(baseDir, entry.targetBefore + remainder + entry.targetAfter);
      }
      return null;
    },
  };
}

/**
 * Builds an alias resolver from an explicit map. Targets resolve relative to `baseDir`.
 */
export function createAliasConfig(aliasMap: AliasMap, baseDir: string): AliasConfig {
  const entries = Object.entries(aliasMap)
    .filter(([, target]) => typeof target === 'string' && target.length > 0)
    .map(([alias, target]) => buildAliasEntry(alias, target as string));

  return createAliasConfigFromEntries(entries, resolve(baseDir));
}

/**
 * Combines an explicit alias resolver with an auto-detected one.
 * Explicit entries take precedence when both can resolve the same specifier.
 */
export function mergeAliasConfigs(
  explicit: AliasConfig | null,
  autoDetected: AliasConfig | null
): AliasConfig | null {
  if (explicit && !autoDetected) return explicit;
  if (!explicit && autoDetected) return autoDetected;
  if (!explicit || !autoDetected) return null;

  return {
    isAlias(specifier: string): boolean {
      return explicit.isAlias(specifier) || autoDetected.isAlias(specifier);
    },
    resolve(specifier: string): string | null {
      return explicit.resolve(specifier) ?? autoDetected.resolve(specifier);
    },
  };
}

/**
 * Strips single-line and multi-line comments and trailing commas from a JSONC string
 * (e.g. standard tsconfig.json or jsconfig.json) so it can be parsed by JSON.parse.
 */
export function stripJsonComments(text: string): string {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, (match, str, prefix) => {
      if (str) return str;
      if (prefix) return prefix;
      return '';
    })
    .replace(/,\s*([\]}])/g, '$1');
}

function resolveExtendsTarget(fromConfigFile: string, extendsTarget: string): string | null {
  const fromDir = dirname(fromConfigFile);

  if (extendsTarget.startsWith('.') || isAbsolute(extendsTarget)) {
    const candidateBase = isAbsolute(extendsTarget) ? extendsTarget : resolve(fromDir, extendsTarget);
    const candidates = [
      candidateBase,
      candidateBase.endsWith('.json') ? candidateBase : candidateBase + '.json',
      join(candidateBase, 'tsconfig.json'),
      join(candidateBase, 'jsconfig.json'),
    ];
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {}
    }
    return null;
  }

  // Bare package specifier (e.g. '@vue/tsconfig/tsconfig.dom.json' or '@tsconfig/node18/tsconfig.json')
  let cur = fromDir;
  while (true) {
    const nodeModulesDir = join(cur, 'node_modules');
    const targetInModules = join(nodeModulesDir, extendsTarget);
    const candidates = [
      targetInModules,
      targetInModules.endsWith('.json') ? targetInModules : targetInModules + '.json',
      join(targetInModules, 'tsconfig.json'),
      join(targetInModules, 'jsconfig.json'),
    ];
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {}
    }

    try {
      const pkgPath = join(targetInModules, 'package.json');
      if (statSync(pkgPath).isFile()) {
        const pkgRaw = readSourceFileSync(pkgPath);
        const pkg = JSON.parse(pkgRaw) as { tsconfig?: string };
        if (pkg.tsconfig) {
          const direct = resolve(targetInModules, pkg.tsconfig);
          if (statSync(direct).isFile()) return direct;
        }
      }
    } catch {}

    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

export interface TsConfigHierarchyResult {
  paths: Record<string, string[]>;
  baseDirForPath: Record<string, string>;
  configFiles: string[];
}

export async function loadTsConfigHierarchy(configFile: string): Promise<TsConfigHierarchyResult> {
  const visited = new Set<string>();
  const configFiles: string[] = [];
  const mergedPaths: Record<string, { targets: string[]; baseDir: string }> = {};

  async function loadRecursive(file: string): Promise<void> {
    const canonical = resolve(file);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    configFiles.push(canonical);

    let raw: string;
    try {
      raw = await readSourceFile(canonical);
    } catch {
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    // 1. Process "extends" first (base configs load before child configs)
    if (parsed.extends) {
      const extendsList = Array.isArray(parsed.extends)
        ? parsed.extends
        : typeof parsed.extends === 'string'
        ? [parsed.extends]
        : [];

      for (const extTarget of extendsList) {
        if (typeof extTarget === 'string' && extTarget.trim()) {
          const resolved = resolveExtendsTarget(canonical, extTarget.trim());
          if (resolved) {
            await loadRecursive(resolved);
          }
        }
      }
    }

    // 2. Process "references" if present and local paths are not defined
    if (Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        if (ref && typeof ref.path === 'string' && ref.path.trim()) {
          const resolved = resolveExtendsTarget(canonical, ref.path.trim());
          if (resolved) {
            await loadRecursive(resolved);
          }
        }
      }
    }

    // 3. Apply this config's compilerOptions.paths (overriding base)
    const currentDir = dirname(canonical);
    const baseUrl = parsed.compilerOptions?.baseUrl;
    const effectiveBaseDir = baseUrl ? resolve(currentDir, baseUrl) : currentDir;
    const localPaths = parsed.compilerOptions?.paths;

    if (localPaths && typeof localPaths === 'object') {
      for (const [alias, targets] of Object.entries(localPaths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          mergedPaths[alias] = {
            targets: targets.map(String),
            baseDir: effectiveBaseDir,
          };
        }
      }
    }
  }

  await loadRecursive(configFile);

  const paths: Record<string, string[]> = {};
  const baseDirForPath: Record<string, string> = {};
  for (const [alias, info] of Object.entries(mergedPaths)) {
    paths[alias] = info.targets;
    baseDirForPath[alias] = info.baseDir;
  }

  return { paths, baseDirForPath, configFiles };
}

export function loadTsConfigHierarchySync(configFile: string): TsConfigHierarchyResult {
  const visited = new Set<string>();
  const configFiles: string[] = [];
  const mergedPaths: Record<string, { targets: string[]; baseDir: string }> = {};

  function loadRecursive(file: string): void {
    const canonical = resolve(file);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    configFiles.push(canonical);

    let raw: string;
    try {
      raw = readSourceFileSync(canonical);
    } catch {
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.extends) {
      const extendsList = Array.isArray(parsed.extends)
        ? parsed.extends
        : typeof parsed.extends === 'string'
        ? [parsed.extends]
        : [];

      for (const extTarget of extendsList) {
        if (typeof extTarget === 'string' && extTarget.trim()) {
          const resolved = resolveExtendsTarget(canonical, extTarget.trim());
          if (resolved) {
            loadRecursive(resolved);
          }
        }
      }
    }

    if (Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        if (ref && typeof ref.path === 'string' && ref.path.trim()) {
          const resolved = resolveExtendsTarget(canonical, ref.path.trim());
          if (resolved) {
            loadRecursive(resolved);
          }
        }
      }
    }

    const currentDir = dirname(canonical);
    const baseUrl = parsed.compilerOptions?.baseUrl;
    const effectiveBaseDir = baseUrl ? resolve(currentDir, baseUrl) : currentDir;
    const localPaths = parsed.compilerOptions?.paths;

    if (localPaths && typeof localPaths === 'object') {
      for (const [alias, targets] of Object.entries(localPaths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          mergedPaths[alias] = {
            targets: targets.map(String),
            baseDir: effectiveBaseDir,
          };
        }
      }
    }
  }

  loadRecursive(configFile);

  const paths: Record<string, string[]> = {};
  const baseDirForPath: Record<string, string> = {};
  for (const [alias, info] of Object.entries(mergedPaths)) {
    paths[alias] = info.targets;
    baseDirForPath[alias] = info.baseDir;
  }

  return { paths, baseDirForPath, configFiles };
}

interface PathEntryWithBaseDir {
  entry: AliasEntry;
  baseDir: string;
}

interface GroupedAliasEntry {
  alias: string;
  targets: PathEntryWithBaseDir[];
  matchKind: AliasMatchKind;
  aliasBefore: string;
}

function buildAliasConfigFromResolvedHierarchy(hierarchy: TsConfigHierarchyResult): AliasConfig {
  const groups: GroupedAliasEntry[] = [];

  for (const [alias, targets] of Object.entries(hierarchy.paths)) {
    const baseDir = hierarchy.baseDirForPath[alias] || process.cwd();
    const entryItems: PathEntryWithBaseDir[] = targets.map(target => ({
      entry: buildAliasEntry(alias, target),
      baseDir,
    }));
    if (entryItems.length === 0) continue;

    groups.push({
      alias,
      targets: entryItems,
      matchKind: entryItems[0].entry.matchKind,
      aliasBefore: entryItems[0].entry.aliasBefore,
    });
  }

  groups.sort((a, b) =>
    Number(b.matchKind === 'exact') - Number(a.matchKind === 'exact') ||
    b.aliasBefore.length - a.aliasBefore.length
  );

  return {
    isAlias: specifier => groups.some(group => matchAliasEntry(group.targets[0].entry, specifier) !== null),
    resolve(specifier) {
      for (const group of groups) {
        const remainder = matchAliasEntry(group.targets[0].entry, specifier);
        if (remainder === null) continue;
        const candidates = group.targets.map(item =>
          resolve(item.baseDir, item.entry.targetBefore + remainder + item.entry.targetAfter)
        );
        for (const candidate of candidates) {
          if (candidate.endsWith('.js') || candidate.endsWith('.jsx')) {
            const jsx = candidate.endsWith('.jsx');
            for (const ext of jsx ? ['.tsx'] : ['.ts', '.tsx']) {
              const source = candidate.slice(0, jsx ? -4 : -3) + ext;
              try { if (statSync(source).isFile()) return source; } catch {}
            }
          }
          if (['', '.vue', '.tsx', '.jsx', '.astro', '.ts', '.js', '/index.vue', '/index.tsx', '/index.jsx', '/index.astro', '/index.ts', '/index.js']
            .some(suffix => {
              try { return statSync(candidate + suffix).isFile(); } catch { return false; }
            })) return candidate;
        }
        return candidates.find(candidate => {
          try { return statSync(candidate).isDirectory(); } catch { return false; }
        }) ?? candidates[0];
      }
      return null;
    },
  };
}

export function buildAliasConfigFromTsconfigPaths(
  configDir: string,
  baseUrl: string | undefined,
  paths: Record<string, string[]>
): AliasConfig {
  const baseDir = baseUrl ? resolve(configDir, baseUrl) : configDir;
  const baseDirForPath: Record<string, string> = {};
  for (const k of Object.keys(paths)) {
    baseDirForPath[k] = baseDir;
  }
  return buildAliasConfigFromResolvedHierarchy({
    paths,
    baseDirForPath,
    configFiles: [configDir],
  });
}

/**
 * Discovers the nearest `jsconfig.json` or `tsconfig.json` walking up from a file
 * and builds an alias resolver from its full inheritance hierarchy (`extends`).
 * Also returns all config files involved in the hierarchy.
 */
export async function loadAliasConfigWithDependencies(
  fromPath: string
): Promise<{ config: AliasConfig | null; configFiles: string[] }> {
  let dir = dirname(resolve(fromPath));

  while (true) {
    for (const name of ['jsconfig.json', 'tsconfig.json']) {
      const candidate = join(dir, name);

      try {
        if (statSync(candidate).isFile()) {
          const hierarchy = await loadTsConfigHierarchy(candidate);
          if (Object.keys(hierarchy.paths).length > 0) {
            return {
              config: buildAliasConfigFromResolvedHierarchy(hierarchy),
              configFiles: hierarchy.configFiles,
            };
          }
        }
      } catch {
        // No config or invalid config at this level — keep walking up.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { config: null, configFiles: [] };
}

/**
 * Discovers the nearest `jsconfig.json` or `tsconfig.json` walking up from a file
 * and builds an alias resolver from its full inheritance hierarchy (`extends`).
 */
export async function loadAliasConfig(fromPath: string): Promise<AliasConfig | null> {
  const { config } = await loadAliasConfigWithDependencies(fromPath);
  return config;
}
