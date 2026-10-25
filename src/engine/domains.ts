import { promises as fs, existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { findProjectRoot } from './path-resolver';

/**
 * Standard source root folder names across frontend and fullstack conventions.
 */
export const STANDARD_SOURCE_ROOTS = [
  'src',
  'resources/js',
  'resources/ts',
  'resources/frontend',
  'client',
  'frontend',
  'web',
  'app',
] as const;

/**
 * Standard code domain folder names used across modern software architectures
 * (Feature-Sliced Design, DDD, MVC, Modular Frontend, Component Libraries).
 */
export const STANDARD_DOMAIN_NAMES = [
  'components',
  'ui',
  'sections',
  'pages',
  'app',
  'routes',
  'views',
  'layouts',
  'domains',
  'features',
  'modules',
  'lib',
  'composables',
  'hooks',
  'services',
  'api',
  'stores',
  'store',
  'utils',
  'helpers',
  'types',
  'typings',
  'context',
  'contexts',
] as const;

/**
 * Non-domain visible folders that should be ignored during application code parsing.
 */
export const NON_DOMAIN_DIRS = new Set([
  // Package Managers & Dependencies
  'node_modules',
  'vendor',
  '.bundle',
  'deps',

  // Build & Output
  'dist',
  'build',
  'out',
  '.output',
  'target',
  'public',
  'storage',

  // Documentation
  'docs',
  'doc',
  'documentation',

  // Tooling, harness & build scripts
  'scripts',
  'tools',

  // Test suites, fixtures & mocks
  'tests',
  'test',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'cypress',
  'fixtures',
  'mocks',

  // Logs & temporary artifacts
  'coverage',
  'logs',
  'tmp',
  'temp',
  'artifacts',
  'benchmarks',
  'benchmark',
]);

export type DomainLayer =
  | 'component'
  | 'route-or-page'
  | 'reusable-logic'
  | 'state'
  | 'service'
  | 'layout'
  | 'utility'
  | 'type'
  | 'domain-module'
  | 'unknown';

export interface DetectedDomain {
  name: string;
  rootPath: string;
  relativePath: string;
  type: 'primary-src' | 'domain-root' | 'hybrid-resource' | 'feature-slice' | 'subdomain';
  layers: DomainLayer[];
  isNested: boolean;
}

export interface CodeDomainResolution {
  projectRoot: string;
  primaryRoot?: string;
  isStandardLayout: boolean;
  activeDomainRoots: string[];
  domains: DetectedDomain[];
}

export interface ClassifiedFileDomain {
  filePath: string;
  relativeToRoot: string;
  isDomainCode: boolean;
  domain?: string;
  subdomain?: string;
  layer: DomainLayer;
  isMultiNested: boolean;
  nestingDepth: number;
}

/**
 * Checks whether a directory name is a non-domain folder (e.g. tests, docs, scripts).
 */
export function isNonDomainDir(dirName: string): boolean {
  if (dirName.startsWith('.') && dirName !== '.' && dirName !== '..') return true;
  return NON_DOMAIN_DIRS.has(dirName.toLowerCase());
}

/**
 * Detects standard code domain roots in a project directory.
 * Anchors to `src/`, `resources/js`, or root-level standard domain directories.
 */
export async function detectCodeDomains(targetDir: string): Promise<CodeDomainResolution> {
  const root = resolve(targetDir);
  const projectRoot = findProjectRoot(root) || root;

  const domains: DetectedDomain[] = [];
  const activeDomainRoots: string[] = [];
  let primaryRoot: string | undefined;

  // 1. Check primary source roots: src/ or resources/js|ts
  const srcCandidate = join(root, 'src');
  const inertiaJsCandidate = join(root, 'resources', 'js');
  const inertiaTsCandidate = join(root, 'resources', 'ts');

  if (existsSync(srcCandidate) && statSync(srcCandidate).isDirectory()) {
    primaryRoot = srcCandidate;
    activeDomainRoots.push(srcCandidate);

    domains.push({
      name: 'src',
      rootPath: srcCandidate,
      relativePath: 'src',
      type: 'primary-src',
      layers: ['domain-module'],
      isNested: false,
    });

    // Inspect subdomains within src (e.g. src/domains/*, src/features/*, src/components, etc.)
    try {
      const srcEntries = await fs.readdir(srcCandidate, { withFileTypes: true });
      for (const entry of srcEntries) {
        if (!entry.isDirectory() || isNonDomainDir(entry.name)) continue;

        const subPath = join(srcCandidate, entry.name);
        const relSubPath = `src/${entry.name}`;

        if (['domains', 'features', 'modules'].includes(entry.name.toLowerCase())) {
          // Dive into nested bounded contexts (e.g. src/domains/billing)
          try {
            const nestedEntries = await fs.readdir(subPath, { withFileTypes: true });
            for (const nested of nestedEntries) {
              if (nested.isDirectory() && !isNonDomainDir(nested.name)) {
                domains.push({
                  name: nested.name,
                  rootPath: join(subPath, nested.name),
                  relativePath: `${relSubPath}/${nested.name}`,
                  type: entry.name.toLowerCase() === 'features' ? 'feature-slice' : 'subdomain',
                  layers: await inspectDomainLayers(join(subPath, nested.name)),
                  isNested: true,
                });
              }
            }
          } catch {
            // Unreadable subdirectory fallback
          }
        } else {
          domains.push({
            name: entry.name,
            rootPath: subPath,
            relativePath: relSubPath,
            type: 'domain-root',
            layers: [inferLayerFromName(entry.name)],
            isNested: false,
          });
        }
      }
    } catch {
      // Unreadable src fallback
    }
  } else if (existsSync(inertiaJsCandidate) && statSync(inertiaJsCandidate).isDirectory()) {
    primaryRoot = inertiaJsCandidate;
    activeDomainRoots.push(inertiaJsCandidate);
    domains.push({
      name: 'resources/js',
      rootPath: inertiaJsCandidate,
      relativePath: 'resources/js',
      type: 'hybrid-resource',
      layers: ['domain-module'],
      isNested: false,
    });
  } else if (existsSync(inertiaTsCandidate) && statSync(inertiaTsCandidate).isDirectory()) {
    primaryRoot = inertiaTsCandidate;
    activeDomainRoots.push(inertiaTsCandidate);
    domains.push({
      name: 'resources/ts',
      rootPath: inertiaTsCandidate,
      relativePath: 'resources/ts',
      type: 'hybrid-resource',
      layers: ['domain-module'],
      isNested: false,
    });
  } else {
    // 2. Flat project root (e.g. Next.js app/, Nuxt pages/, Astro pages/ directly at root)
    try {
      const rootEntries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (!entry.isDirectory() || isNonDomainDir(entry.name)) continue;

        const lower = entry.name.toLowerCase();
        const isStandard = STANDARD_DOMAIN_NAMES.includes(lower as any);

        if (isStandard) {
          const domainPath = join(root, entry.name);
          activeDomainRoots.push(domainPath);
          domains.push({
            name: entry.name,
            rootPath: domainPath,
            relativePath: entry.name,
            type: 'domain-root',
            layers: [inferLayerFromName(entry.name)],
            isNested: false,
          });
        }
      }
    } catch {
      // Unreadable root fallback
    }
  }

  return {
    projectRoot,
    primaryRoot,
    isStandardLayout: activeDomainRoots.length > 0,
    activeDomainRoots,
    domains,
  };
}

/**
 * Classifies a specific file into its architectural domain, subdomain, and layer.
 * Correctly accounts for multi-nested directory structures.
 */
export function classifyFileDomain(filePath: string, rootDir: string): ClassifiedFileDomain {
  const normFile = normalize(resolve(filePath));
  const normRoot = normalize(resolve(rootDir));
  const relPath = relative(normRoot, normFile).replace(/\\/g, '/');

  const segments = relPath.split('/').filter(Boolean);
  const fileName = segments.pop() || '';

  // 1. Non-domain detection (in ignored directories or outside standard structure)
  for (const seg of segments) {
    if (isNonDomainDir(seg)) {
      return {
        filePath: normFile,
        relativeToRoot: relPath,
        isDomainCode: false,
        layer: 'unknown',
        isMultiNested: segments.length >= 2,
        nestingDepth: segments.length,
      };
    }
  }

  // Strip primary root wrapper ('src' or 'resources/js') for domain extraction
  let domainSegments = [...segments];
  if (domainSegments[0] === 'src') {
    domainSegments.shift();
  } else if (domainSegments[0] === 'resources' && (domainSegments[1] === 'js' || domainSegments[1] === 'ts')) {
    domainSegments = domainSegments.slice(2);
  }

  let domain: string | undefined;
  let subdomain: string | undefined;
  let layer: DomainLayer = 'unknown';

  if (domainSegments.length === 0) {
    // Root level source file (e.g. src/App.vue or src/main.ts)
    layer = inferLayerFromFile(fileName);
    domain = 'root';
  } else if (['domains', 'features', 'modules'].includes(domainSegments[0].toLowerCase()) && domainSegments.length >= 2) {
    domain = domainSegments[1];
    if (domainSegments.length >= 3) {
      layer = inferLayerFromName(domainSegments[2]);
      if (domainSegments.length >= 4) {
        subdomain = domainSegments[3];
      }
    } else {
      layer = 'domain-module';
    }
  } else {
    domain = domainSegments[0];
    layer = inferLayerFromName(domainSegments[0]);
    if (domainSegments.length >= 2) {
      subdomain = domainSegments[1];
    }
  }

  if (layer === 'unknown') {
    layer = inferLayerFromFile(fileName);
  }

  return {
    filePath: normFile,
    relativeToRoot: relPath,
    isDomainCode: true,
    domain,
    subdomain,
    layer,
    isMultiNested: segments.length >= 3,
    nestingDepth: segments.length,
  };
}

/**
 * Infers domain layer from a directory segment name.
 */
function inferLayerFromName(name: string): DomainLayer {
  const lower = name.toLowerCase();
  if (/^(components?|ui|sections?|widgets?)$/.test(lower)) return 'component';
  if (/^(pages?|app|routes?|views?)$/.test(lower)) return 'route-or-page';
  if (/^(composables?|hooks?)$/.test(lower)) return 'reusable-logic';
  if (/^(stores?|state|context|contexts?)$/.test(lower)) return 'state';
  if (/^(services?|api|endpoints?|clients?)$/.test(lower)) return 'service';
  if (/^(layouts?)$/.test(lower)) return 'layout';
  if (/^(utils?|helpers?|lib)$/.test(lower)) return 'utility';
  if (/^(types?|typings?|interfaces?|models?)$/.test(lower)) return 'type';
  if (/^(domains?|features?|modules?)$/.test(lower)) return 'domain-module';
  return 'unknown';
}

/**
 * Infers domain layer from file name and extension.
 */
function inferLayerFromFile(fileName: string): DomainLayer {
  const ext = extname(fileName).toLowerCase();
  if (['.vue', '.astro', '.svelte'].includes(ext)) {
    if (/layout/i.test(fileName)) return 'layout';
    if (/view|page/i.test(fileName)) return 'route-or-page';
    return 'component';
  }
  if (/\.(test|spec)\.[jt]sx?$/.test(fileName)) return 'unknown';
  if (/use[A-Z]/.test(fileName)) return 'reusable-logic';
  if (/store|pinia/i.test(fileName)) return 'state';
  if (/service|client|api/i.test(fileName)) return 'service';
  if (/types?|models?/i.test(fileName)) return 'type';
  if (['.tsx', '.jsx'].includes(ext)) return 'component';
  return 'utility';
}

/**
 * Inspects subdirectories of a bounded domain to identify contained layers.
 */
async function inspectDomainLayers(domainDir: string): Promise<DomainLayer[]> {
  const layers = new Set<DomainLayer>();
  try {
    const entries = await fs.readdir(domainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const layer = inferLayerFromName(entry.name);
        if (layer !== 'unknown') layers.add(layer);
      }
    }
  } catch {
    // Ignore read errors
  }
  if (layers.size === 0) layers.add('domain-module');
  return Array.from(layers);
}
