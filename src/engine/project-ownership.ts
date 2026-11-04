import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectOwnershipInfo } from '../types';

const configs = {
  next: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
  nuxt: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'],
  astro: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
  svelte: ['svelte.config.js', 'svelte.config.ts'],
} as const;
const genericConfigs = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
const markers = ['package.json', ...Object.values(configs).flat(), ...genericConfigs];

function physicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    suffix.unshift(relative(dirname(current), current)); current = dirname(current);
  }
  try { return resolve(realpathSync(current), ...suffix); } catch { return resolve(path); }
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Scope bounds source membership; the nearest package/config owns it, even above a selected subdirectory. */
export function resolveProjectOwnership(filePath: string, scopeRoot?: string): ProjectOwnershipInfo {
  const file = physicalPath(filePath);
  const scope = scopeRoot ? physicalPath(scopeRoot) : null;
  const result: ProjectOwnershipInfo = { scopeRoot: scope, ownerRoot: null, status: 'unverified',
    applicationFramework: null, appRoot: null, configFiles: [], dependencies: [], diagnostics: [] };
  if (scope && !contains(scope, file)) {
    result.status = 'outside-scope';
    result.diagnostics.push({ code: 'PROJECT_OWNER_OUTSIDE_SCOPE', reason: 'The physical source path is outside the selected scope; no ancestor application ownership is inherited.' });
    return result;
  }
  let dir = dirname(file);
  for (let depth = 0; depth < 128; depth++) {
    const found = markers.filter(name => existsSync(join(dir, name)));
    if (found.length) {
      result.ownerRoot = dir; result.status = 'owned';
      const contents = new Map<string, string>();
      for (const name of found) {
        const path = join(dir, name);
        try {
          const content = readFileSync(path, 'utf8'); contents.set(name, content);
          result.dependencies.push({ path, hash: createHash('sha256').update(content).digest('hex'), isExternal: Boolean(scope && !contains(scope, path)) });
        } catch {
          result.status = 'unverified';
          result.diagnostics.push({ code: 'PROJECT_OWNER_INPUT_UNREADABLE', reason: `${path}: ownership input could not be read; no framework is selected from partial inputs.` });
        }
      }
      result.configFiles = found.filter(name => name !== 'package.json').map(name => join(dir, name));
      let deps: Record<string, unknown> = {};
      if (contents.has('package.json')) {
        try {
          const pkg = JSON.parse(contents.get('package.json')!);
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid manifest object');
          for (const map of [pkg.dependencies, pkg.devDependencies]) {
            if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map)
              || Object.values(map).some(value => typeof value !== 'string'))) throw new Error('Invalid dependency declarations');
          }
          deps = { ...pkg.dependencies, ...pkg.devDependencies };
        } catch {
          result.status = 'unverified';
          result.diagnostics.push({ code: 'PROJECT_OWNER_MANIFEST_INVALID', reason: `${join(dir, 'package.json')}: invalid manifest; parent framework ownership is not inherited.` });
        }
      }
      if (result.status !== 'owned') return result;
      const configured = (Object.keys(configs) as Array<keyof typeof configs>)
        .filter(fw => configs[fw].some(name => found.includes(name)));
      const declared = (['next', 'nuxt', 'astro', 'svelte'] as const).filter(fw =>
        fw === 'nuxt' ? deps.nuxt || deps.nuxt3 : fw === 'svelte' ? deps['@sveltejs/kit'] : deps[fw]);
      const candidates = configured.length ? configured : declared;
      if (candidates.length > 1 || (!configured.length && candidates.length && genericConfigs.some(name => found.includes(name)))) {
        result.status = 'conflict';
        result.diagnostics.push({ code: 'PROJECT_FRAMEWORK_CONFLICT', reason: `${dir}: competing application evidence (${candidates.join(', ')}${genericConfigs.some(name => found.includes(name)) ? ', Vite config' : ''}); no application convention is selected.` });
      } else if (candidates.length === 1) result.applicationFramework = candidates[0];
      if (result.applicationFramework === 'next') {
        const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
        const rootApp = join(dir, 'app'); const srcApp = join(dir, 'src', 'app');
        if (isDirectory(rootApp)) result.appRoot = rootApp;
        else if (isDirectory(srcApp)) result.appRoot = srcApp;
      }
      return result;
    }
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  result.diagnostics.push({ code: 'PROJECT_OWNER_UNVERIFIED', reason: 'No package/application config owner was found before the filesystem root or traversal limit.' });
  return result;
}

export function isOwnedNextAppFile(filePath: string, context: ProjectOwnershipInfo): boolean {
  return context.status === 'owned' && context.applicationFramework === 'next' && Boolean(context.appRoot)
    && contains(context.appRoot!, physicalPath(filePath));
}
