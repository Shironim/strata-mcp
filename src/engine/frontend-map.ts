import { promises as fs } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { collectFilesWithReport, type ExcludedDirectoryReport } from './collector';
import { detectCodeDomains, classifyFileDomain } from './domains';

const COVERED = ['.vue', '.astro', '.svelte', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export async function mapFrontendScope(path: string, options: { limit?: number; offset?: number; excludeDirs?: string[] } = {}) {
  const root = resolve(path);
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const offset = Math.max(0, options.offset ?? 0);
  const collected = await collectFilesWithReport(root, { excludeDirs: options.excludeDirs });
  const files = collected.files.sort();
  const excludedDirs = collected.excludedDirs;
  const domainResolution = await detectCodeDomains(root);
  const manifests = await Promise.all([
    readPackageManifest(root),
    ...domainResolution.activeDomainRoots.map((d) => readPackageManifest(d)),
  ]);
  const dependencies: Record<string, string> = {};
  for (const manifest of manifests) {
    if (manifest?.dependencies) Object.assign(dependencies, manifest.dependencies);
    if (manifest?.devDependencies) Object.assign(dependencies, manifest.devDependencies);
  }
  const frameworks = ['vue', 'nuxt', 'react', 'next', 'astro', 'svelte', 'solid']
    .filter(name => {
      if (name === 'react') return Boolean(dependencies.react);
      if (name === 'solid') return Boolean(dependencies['solid-js']);
      return Boolean(dependencies[name]);
    })
    .map(name => ({ name, evidence: { basis: 'derived' as const, resolution: 'candidate' as const, method: 'package-manifest-dependency' } }));
  if (frameworks.length === 0) {
    const configMap: Array<[RegExp, string]> = [
      [/\/nuxt\.config\.(?:ts|js|mjs|cjs)$/i, 'nuxt'],
      [/\/next\.config\.(?:ts|js|mjs|cjs)$/i, 'next'],
      [/\/astro\.config\.(?:ts|js|mjs|cjs)$/i, 'astro'],
      [/\/svelte\.config\.(?:ts|js|mjs|cjs)$/i, 'svelte'],
    ];
    for (const [re, name] of configMap) {
      if (files.some((f) => re.test(f.replace(/\\/g, '/'))) && !frameworks.some((fw) => fw.name === name)) {
        frameworks.push({ name, evidence: { basis: 'derived' as const, resolution: 'candidate' as const, method: 'package-manifest-dependency' } });
      }
    }
  }
  const selected = files.slice(offset, offset + limit);
  const extensions = Object.fromEntries(COVERED.map(ext => [ext, files.filter(file => extname(file).toLowerCase() === ext).length]));
  return {
    root,
    scope: { path: root, basis: 'requested-path' },
    status: offset + selected.length < files.length ? 'partial' : 'complete',
    coverage: {
      knownFiles: files.length,
      returnedFiles: selected.length,
      offset,
      limit,
      truncated: offset + selected.length < files.length,
      excludedDirs,
      extensions,
    },
    domainRoots: domainResolution.activeDomainRoots,
    domains: domainResolution.domains,
    agentHarnesses: domainResolution.agentHarnesses,
    frameworkCandidates: frameworks,
    frameworkDetection: frameworks.length ? 'package-manifest dependencies; candidate only' : 'unknown (no matching package dependency found)',
    files: selected.map(file => {
      const classification = classifyFileDomain(file, root);
      const hint = roleHint(root, file) || (classification.layer !== 'unknown' ? classification.layer : undefined);
      return {
        path: file,
        ...(classification.domain ? { domain: classification.domain } : {}),
        ...(classification.subdomain ? { subdomain: classification.subdomain } : {}),
        ...(classification.layer !== 'unknown' ? { layer: classification.layer } : {}),
        isMultiNested: classification.isMultiNested,
        ...(hint ? { roleHint: hint, roleHintEvidence: { basis: 'heuristic' as const, resolution: 'candidate' as const, method: 'path-convention' } } : {}),
      };
    }),
    unsupportedExtensions: ['.css', '.scss', '.sass', '.less', '.mdx'],
  };
}

export function formatFrontendMapAsText(result: Awaited<ReturnType<typeof mapFrontendScope>>): string {
  const excludedDirs: ExcludedDirectoryReport[] = result.coverage.excludedDirs ?? [];
  const exclusionNote = excludedDirs.length > 0
    ? ` (excluding ${excludedDirs.length} director${excludedDirs.length === 1 ? 'y' : 'ies'})`
    : '';
  const lines = [
    `Frontend map: ${result.root}`,
    `Status: ${result.status}${exclusionNote}; ${result.coverage.returnedFiles}/${result.coverage.knownFiles} files returned (offset ${result.coverage.offset})`,
    `Framework candidates: ${result.frameworkCandidates.map(item => item.name).join(', ') || 'unknown'} (${result.frameworkDetection})`,
    ...result.files.map(file => {
      const rel = relative(result.root, file.path) || file.path;
      return `- ${rel}${file.roleHint ? ` [${file.roleHint}; heuristic]` : ''}`;
    }),
  ];
  if (excludedDirs.length > 0) {
    const shown = excludedDirs.slice(0, 20).map(item => `${item.path} (${item.reason})`);
    const remainder = excludedDirs.length > 20 ? `, +${excludedDirs.length - 20} more` : '';
    lines.push(`Excluded directories: ${shown.join(', ')}${remainder}`);
  }
  lines.push(`Extension coverage: ${Object.entries(result.coverage.extensions).filter(([, count]) => count > 0).map(([ext, count]) => `${ext}=${count}`).join(', ') || 'none'}`);
  return lines.join('\n');
}

async function readPackageManifest(root: string): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null> {
  try { return JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8')); }
  catch { return null; }
}

function roleHint(root: string, file: string): string | undefined {
  const relative = file.slice(root.length).replace(/\\/g, '/');
  const parts = relative.split('/').filter(Boolean);
  const segments = parts.length > 1 ? parts.slice(0, -1) : [basename(file, extname(file))];
  if (segments.some((s) => /^(components?|ui)$/i.test(s))) return 'component';
  if (segments.some((s) => /^(pages?|routes?)$/i.test(s))) return 'route-or-page';
  if (segments.some((s) => /^(composables?|hooks?)$/i.test(s))) return 'reusable-logic';
  if (segments.some((s) => /^app$/i.test(s))) return 'route-or-page';
  return undefined;
}
