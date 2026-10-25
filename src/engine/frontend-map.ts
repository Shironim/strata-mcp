import { promises as fs } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { collectFiles } from './collector';

const COVERED = ['.vue', '.astro', '.svelte', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export async function mapFrontendScope(path: string, options: { limit?: number; offset?: number; excludeDirs?: string[] } = {}) {
  const root = resolve(path);
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const offset = Math.max(0, options.offset ?? 0);
  const files = (await collectFiles(root, { excludeDirs: options.excludeDirs })).sort();
  const manifest = await readPackageManifest(root);
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const frameworks = ['vue', 'nuxt', 'react', 'next', 'astro', 'svelte', 'solid']
    .filter(name => {
      if (name === 'react') return Boolean(dependencies.react);
      if (name === 'solid') return Boolean(dependencies['solid-js']);
      return Boolean(dependencies[name]);
    })
    .map(name => ({ name, evidence: { basis: 'derived' as const, resolution: 'candidate' as const, method: 'package-manifest-dependency' } }));
  const selected = files.slice(offset, offset + limit);
  const extensions = Object.fromEntries(COVERED.map(ext => [ext, files.filter(file => extname(file).toLowerCase() === ext).length]));
  return {
    root,
    scope: { path: root, basis: 'requested-path' },
    status: offset + selected.length < files.length ? 'partial' : 'complete',
    coverage: { knownFiles: files.length, returnedFiles: selected.length, offset, limit, truncated: offset + selected.length < files.length, extensions },
    frameworkCandidates: frameworks,
    frameworkDetection: frameworks.length ? 'package-manifest dependencies; candidate only' : 'unknown (no matching package dependency found)',
    files: selected.map(file => ({
      path: file,
      ...(roleHint(root, file) ? { roleHint: roleHint(root, file), roleHintEvidence: { basis: 'heuristic' as const, resolution: 'candidate' as const, method: 'path-convention' } } : {}),
    })),
    unsupportedExtensions: ['.css', '.scss', '.sass', '.less', '.mdx'],
  };
}

async function readPackageManifest(root: string): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null> {
  try { return JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8')); }
  catch { return null; }
}

function roleHint(root: string, file: string): string | undefined {
  const relative = file.slice(root.length).replace(/\\/g, '/');
  const parts = relative.split('/').slice(1);
  const folder = parts.length > 1 ? parts[0] : basename(file, extname(file));
  return /^(components?|ui)$/i.test(folder) ? 'component' : /^(pages?|app|routes?)$/i.test(folder) ? 'route-or-page' : /^(composables?|hooks?)$/i.test(folder) ? 'reusable-logic' : undefined;
}
