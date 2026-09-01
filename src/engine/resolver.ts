import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
    .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1')
    .replace(/,\s*([\]}])/g, '$1');
}

/**
 * Discovers the nearest `jsconfig.json` or `tsconfig.json` walking up from a file
 * and builds an alias resolver from its `compilerOptions.paths` + `baseUrl`.
 */
export async function loadAliasConfig(fromPath: string): Promise<AliasConfig | null> {
  let dir = dirname(resolve(fromPath));

  while (true) {
    for (const name of ['jsconfig.json', 'tsconfig.json']) {
      const candidate = join(dir, name);

      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const config = JSON.parse(stripJsonComments(raw)) as {
          compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        };

        const baseUrl = config.compilerOptions?.baseUrl;
        const paths = config.compilerOptions?.paths;

        if (paths && typeof paths === 'object') {
          return buildAliasConfigFromTsconfigPaths(dir, baseUrl, paths);
        }
      } catch {
        // No config or invalid config at this level — keep walking up.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function buildAliasConfigFromTsconfigPaths(
  configDir: string,
  baseUrl: string | undefined,
  paths: Record<string, string[]>
): AliasConfig {
  const baseDir = baseUrl ? resolve(configDir, baseUrl) : configDir;

  const entries = Object.entries(paths)
    .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
    .map(([alias, targets]) => buildAliasEntry(alias, String(targets[0])));

  return createAliasConfigFromEntries(entries, baseDir);
}
