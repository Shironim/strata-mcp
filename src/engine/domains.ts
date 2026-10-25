import { promises as fs, existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { findProjectRoot } from './path-resolver';

/**
 * Standard source root folder names across frontend and fullstack conventions,
 * including monorepo workspaces and hybrid frameworks.
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
  'apps',
  'packages',
  'libs',
] as const;

/**
 * Standard code domain folder names used across modern software architectures
 * (Feature-Sliced Design, DDD, Clean Architecture, MVC, Modular Frontend, Component Libraries).
 */
export const STANDARD_DOMAIN_NAMES = [
  'components',
  'ui',
  'sections',
  'widgets',
  'entities',
  'shared',
  'processes',
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
  'server',
  'actions',
  'middleware',
  'plugins',
  'content',
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
 * AI Agent harness directories across Antigravity, Claude Code, Codex, OpenCode, and .agents.
 */
export const AI_AGENT_DIRS = new Set([
  '.agents',
  '.gemini',
  '.claude',
  '.codex',
  '.codex-evidence',
  '.opencode',
  'opencode',
  '.strata',
]);

/**
 * Non-domain visible folders that should be ignored during application code parsing.
 */
export const NON_DOMAIN_DIRS = new Set([
  // AI Agent Harnesses & Metadata
  ...AI_AGENT_DIRS,

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
  | 'widget'
  | 'route-or-page'
  | 'reusable-logic'
  | 'state'
  | 'service'
  | 'layout'
  | 'middleware'
  | 'plugin'
  | 'action'
  | 'content'
  | 'utility'
  | 'type'
  | 'domain-module'
  | 'unknown';

export interface DetectedDomain {
  name: string;
  rootPath: string;
  relativePath: string;
  type: 'primary-src' | 'domain-root' | 'hybrid-resource' | 'feature-slice' | 'subdomain' | 'monorepo-package';
  layers: DomainLayer[];
  isNested: boolean;
  packageScope?: string;
}

export interface AgentHarnessConfig {
  harness: string;
  dir: string;
  hasRules: boolean;
  hasSkills: boolean;
  hasHooks: boolean;
  hasMcpConfig: boolean;
  files: string[];
}

export interface CodeDomainResolution {
  projectRoot: string;
  primaryRoot?: string;
  isStandardLayout: boolean;
  activeDomainRoots: string[];
  domains: DetectedDomain[];
  agentHarnesses: AgentHarnessConfig[];
}

export interface ClassifiedFileDomain {
  filePath: string;
  relativeToRoot: string;
  isDomainCode: boolean;
  isHarnessConfig?: boolean;
  harnessType?: string;
  packageScope?: string;
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
 * Checks whether a file is a non-domain fixture (unit tests, specs, storybooks, mocks).
 */
export function isNonDomainFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    /\.(test|spec)\.[jt]sx?$/.test(lower) ||
    /\.(stories|story)\.[jt]sx?$/.test(lower) ||
    /\.(mock|fixture)\.[jt]sx?$/.test(lower)
  );
}

/**
 * Detects standard code domain roots in a project directory.
 * Anchors to `src/`, `resources/js`, monorepo packages (`apps/*`, `packages/*`),
 * or root-level standard domain directories.
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

    // Inspect subdomains within src (e.g. src/domains/*, src/features/*, src/entities/*, src/widgets/*, src/components, etc.)
    try {
      const srcEntries = await fs.readdir(srcCandidate, { withFileTypes: true });
      for (const entry of srcEntries) {
        if (!entry.isDirectory() || isNonDomainDir(entry.name)) continue;

        const subPath = join(srcCandidate, entry.name);
        const relSubPath = `src/${entry.name}`;
        const lowerName = entry.name.toLowerCase();

        if (['domains', 'features', 'modules', 'entities', 'widgets'].includes(lowerName)) {
          // Dive into nested bounded contexts (e.g. src/domains/billing, src/features/auth)
          try {
            const nestedEntries = await fs.readdir(subPath, { withFileTypes: true });
            for (const nested of nestedEntries) {
              if (nested.isDirectory() && !isNonDomainDir(nested.name)) {
                domains.push({
                  name: nested.name,
                  rootPath: join(subPath, nested.name),
                  relativePath: `${relSubPath}/${nested.name}`,
                  type: lowerName === 'features' ? 'feature-slice' : 'subdomain',
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
    // 2. Monorepo detection: apps/* or packages/* or libs/*
    let foundMonorepoPackages = false;
    for (const monoDir of ['apps', 'packages', 'libs']) {
      const monoPath = join(root, monoDir);
      if (existsSync(monoPath) && statSync(monoPath).isDirectory()) {
        try {
          const pkgEntries = await fs.readdir(monoPath, { withFileTypes: true });
          for (const pkg of pkgEntries) {
            if (!pkg.isDirectory() || isNonDomainDir(pkg.name)) continue;
            const pkgRoot = join(monoPath, pkg.name);
            const pkgSrc = join(pkgRoot, 'src');
            const targetRoot = existsSync(pkgSrc) && statSync(pkgSrc).isDirectory() ? pkgSrc : pkgRoot;

            activeDomainRoots.push(targetRoot);
            domains.push({
              name: `${pkg.name}`,
              rootPath: targetRoot,
              relativePath: relative(root, targetRoot).replace(/\\/g, '/'),
              type: 'monorepo-package',
              layers: ['domain-module'],
              isNested: false,
              packageScope: pkg.name,
            });
            foundMonorepoPackages = true;
          }
        } catch {
          // Skip unreadable monorepo folder
        }
      }
    }

    // 3. Flat project root (e.g. Next.js app/, Nuxt pages/, Astro pages/ directly at root)
    if (!foundMonorepoPackages) {
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
  }

  const agentHarnesses = await detectAgentHarnesses(root);

  return {
    projectRoot,
    primaryRoot,
    isStandardLayout: activeDomainRoots.length > 0,
    activeDomainRoots,
    domains,
    agentHarnesses,
  };
}

/**
 * Detects AI agent harnesses configured in the workspace.
 * Focused exclusively on: Antigravity (.gemini), Claude Code (.claude), Codex (.codex),
 * Opencode (opencode/), and .agents (general).
 */
export async function detectAgentHarnesses(projectRoot: string): Promise<AgentHarnessConfig[]> {
  const harnesses: AgentHarnessConfig[] = [];
  const root = resolve(projectRoot);

  const configs: Array<{ name: string; dir: string; altDir?: string; markers: string[]; mcpFiles: string[] }> = [
    {
      name: 'Google Antigravity',
      dir: '.gemini',
      markers: ['GEMINI.md', 'rules', 'skills', 'hooks'],
      mcpFiles: ['mcp_config.json', 'hooks.json'],
    },
    {
      name: 'Claude Code',
      dir: '.claude',
      markers: ['CLAUDE.md', 'rules', 'skills', 'hooks', 'commands'],
      mcpFiles: ['.mcp.json', 'mcp.json', 'settings.json'],
    },
    {
      name: 'Codex',
      dir: '.codex',
      markers: ['AGENTS.md', 'rules', 'skills', 'hooks'],
      mcpFiles: ['config.toml', 'mcp.json', 'hooks.json'],
    },
    {
      name: 'OpenCode',
      dir: 'opencode',
      altDir: '.opencode',
      markers: ['opencode.json', 'rules', 'skills', 'hooks'],
      mcpFiles: ['opencode.json', 'mcp.json', 'hooks.json'],
    },
    {
      name: '.agents (general)',
      dir: '.agents',
      markers: ['AGENTS.md', 'rules', 'skills', 'hooks'],
      mcpFiles: ['mcp.json', 'hooks.json'],
    },
  ];

  for (const cfg of configs) {
    let dirPath = join(root, cfg.dir);
    let hasDir = existsSync(dirPath) && statSync(dirPath).isDirectory();
    let effectiveDir = cfg.dir;

    if (!hasDir && cfg.altDir) {
      const altPath = join(root, cfg.altDir);
      if (existsSync(altPath) && statSync(altPath).isDirectory()) {
        dirPath = altPath;
        hasDir = true;
        effectiveDir = cfg.altDir;
      }
    }

    const foundFiles: string[] = [];

    for (const marker of cfg.markers) {
      const rootMarkerPath = join(root, marker);
      if (existsSync(rootMarkerPath)) {
        foundFiles.push(marker);
      }
    }

    if (hasDir) {
      foundFiles.push(effectiveDir);
    }

    if (foundFiles.length > 0) {
      const hasRules =
        existsSync(join(dirPath, 'rules')) ||
        (cfg.dir === '.gemini' && existsSync(join(root, 'GEMINI.md'))) ||
        (cfg.dir === '.claude' && existsSync(join(root, 'CLAUDE.md'))) ||
        (['.codex', 'opencode', '.agents'].includes(cfg.dir) && existsSync(join(root, 'AGENTS.md')));
      const hasSkills = existsSync(join(dirPath, 'skills'));
      const hasHooks = existsSync(join(dirPath, 'hooks'));
      const hasMcpConfig = cfg.mcpFiles.some(f => existsSync(join(dirPath, f)) || existsSync(join(root, f)));

      harnesses.push({
        harness: cfg.name,
        dir: effectiveDir,
        hasRules,
        hasSkills,
        hasHooks,
        hasMcpConfig,
        files: foundFiles,
      });
    }
  }

  return harnesses;
}

/**
 * Classifies a specific file into its architectural domain, subdomain, and layer.
 * Correctly accounts for multi-nested directory structures, monorepo workspaces,
 * Feature-Sliced Design (FSD), DDD bounded contexts, and meta-framework conventions.
 */
export function classifyFileDomain(filePath: string, rootDir: string): ClassifiedFileDomain {
  const normFile = normalize(resolve(filePath));
  const normRoot = normalize(resolve(rootDir));
  const relPath = relative(normRoot, normFile).replace(/\\/g, '/');

  const segments = relPath.split('/').filter(Boolean);
  const fileName = segments.pop() || '';

  // 1. In-file non-domain fixture check (*.test.*, *.spec.*, *.stories.*, *.mock.*)
  if (isNonDomainFile(fileName)) {
    return {
      filePath: normFile,
      relativeToRoot: relPath,
      isDomainCode: false,
      layer: 'unknown',
      isMultiNested: segments.length >= 2,
      nestingDepth: segments.length,
    };
  }

  // 2. AI agent harness configuration detection (.gemini, .agents, .cursor, .claude, etc.)
  const harnessMatch = detectFileHarness(segments, fileName);
  if (harnessMatch) {
    return {
      filePath: normFile,
      relativeToRoot: relPath,
      isDomainCode: false,
      isHarnessConfig: true,
      harnessType: harnessMatch,
      layer: 'unknown',
      isMultiNested: segments.length >= 2,
      nestingDepth: segments.length,
    };
  }

  // 3. Directory non-domain detection (in ignored directories or outside standard structure)
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

  let domainSegments = [...segments];
  let packageScope: string | undefined;

  // 3. Monorepo workspace extraction: apps/* or packages/* or libs/*
  if (['apps', 'packages', 'libs'].includes(domainSegments[0]?.toLowerCase()) && domainSegments.length >= 2) {
    packageScope = domainSegments[1];
    domainSegments = domainSegments.slice(2);
  }

  // 4. Strip primary root wrapper ('src' or 'resources/js') for domain extraction
  if (domainSegments[0] === 'src') {
    domainSegments.shift();
  } else if (domainSegments[0] === 'resources' && (domainSegments[1] === 'js' || domainSegments[1] === 'ts')) {
    domainSegments = domainSegments.slice(2);
  }

  let domain: string | undefined;
  let subdomain: string | undefined;
  let layer: DomainLayer = 'unknown';

  if (domainSegments.length === 0) {
    // Root level source file (e.g. src/App.vue or src/main.ts or app/root.tsx)
    layer = inferLayerFromFile(fileName);
    domain = 'root';
  } else if (
    ['domains', 'features', 'modules', 'entities', 'widgets'].includes(domainSegments[0].toLowerCase()) &&
    domainSegments.length >= 2
  ) {
    // DDD / FSD Bounded context (e.g. src/domains/billing/components/InvoiceTable.vue)
    domain = domainSegments[1];
    if (domainSegments.length >= 3) {
      layer = inferLayerFromName(domainSegments[2]);
      if (domainSegments.length >= 4) {
        subdomain = domainSegments[3];
      }
    } else {
      layer = inferLayerFromName(domainSegments[0]);
    }
  } else if (domainSegments[0].toLowerCase() === 'shared' && domainSegments.length >= 2) {
    // FSD Shared segment (e.g. src/shared/ui/Button.tsx or src/shared/api/client.ts)
    domain = 'shared';
    subdomain = domainSegments[1];
    layer = inferLayerFromName(domainSegments[1]);
  } else {
    // Standard layer domain (e.g. src/components/ui/Button.tsx or app/(dashboard)/page.tsx)
    domain = domainSegments[0];
    layer = inferLayerFromName(domainSegments[0]);
    if (domainSegments.length >= 2) {
      subdomain = domainSegments[1];
    }
  }

  if (layer === 'unknown') {
    layer = inferLayerFromFile(fileName);
  } else {
    // File-level specific role override (e.g. layout.tsx, route.ts, actions.ts, +server.ts)
    const fileLayer = inferLayerFromFile(fileName);
    if (fileLayer !== 'unknown' && fileLayer !== 'utility' && fileLayer !== 'component') {
      layer = fileLayer;
    }
  }

  return {
    filePath: normFile,
    relativeToRoot: relPath,
    isDomainCode: true,
    packageScope,
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
export function inferLayerFromName(name: string): DomainLayer {
  const lower = name.toLowerCase();
  if (/^(components?|ui|sections?)$/.test(lower)) return 'component';
  if (/^(widgets?)$/.test(lower)) return 'widget';
  if (/^(pages?|app|routes?|views?)$/.test(lower)) return 'route-or-page';
  if (/^(composables?|hooks?)$/.test(lower)) return 'reusable-logic';
  if (/^(stores?|state|context|contexts?)$/.test(lower)) return 'state';
  if (/^(services?|api|endpoints?|clients?|server)$/.test(lower)) return 'service';
  if (/^(layouts?)$/.test(lower)) return 'layout';
  if (/^(middleware)$/.test(lower)) return 'middleware';
  if (/^(plugins?)$/.test(lower)) return 'plugin';
  if (/^(actions?)$/.test(lower)) return 'action';
  if (/^(content|contents?)$/.test(lower)) return 'content';
  if (/^(utils?|helpers?|lib|shared)$/.test(lower)) return 'utility';
  if (/^(types?|typings?|interfaces?|models?)$/.test(lower)) return 'type';
  if (/^(domains?|features?|modules?|entities?|processes?)$/.test(lower)) return 'domain-module';
  return 'unknown';
}

/**
 * Infers domain layer from file name and extension with support for meta-frameworks
 * (Next.js App Router, Nuxt 3 Nitro & composables, SvelteKit routing, Astro).
 */
export function inferLayerFromFile(fileName: string): DomainLayer {
  const ext = extname(fileName).toLowerCase();

  // Non-domain files
  if (isNonDomainFile(fileName)) return 'unknown';

  // SvelteKit special file routing conventions
  if (fileName.startsWith('+page')) return 'route-or-page';
  if (fileName.startsWith('+layout')) return 'layout';
  if (fileName.startsWith('+server')) return 'service';
  if (fileName.startsWith('+error')) return 'route-or-page';
  if (fileName.startsWith('hooks.server') || fileName.startsWith('hooks.client')) return 'middleware';

  // Next.js App Router conventions
  if (/^(page|loading|error|not-found|template)\.[jt]sx?$/.test(fileName)) return 'route-or-page';
  if (/^layout\.[jt]sx?$/.test(fileName)) return 'layout';
  if (/^route\.[jt]sx?$/.test(fileName)) return 'service';
  if (/^middleware\.[jt]sx?$/.test(fileName)) return 'middleware';
  if (/^actions?\.[jt]sx?$/.test(fileName)) return 'action';

  // Frontend SFCs
  if (['.vue', '.astro', '.svelte'].includes(ext)) {
    if (/layout/i.test(fileName)) return 'layout';
    if (/view|page/i.test(fileName)) return 'route-or-page';
    return 'component';
  }

  // Functional heuristics
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

/**
 * Identifies which AI agent harness a path belongs to.
 * Focused exclusively on: Antigravity (.gemini), Claude Code (.claude), Codex (.codex),
 * Opencode (opencode/), and .agents (general).
 */
function detectFileHarness(segments: string[], fileName: string): string | undefined {
  const allParts = [...segments, fileName].map(p => p.toLowerCase());
  if (allParts.some(p => p === '.gemini' || p === 'gemini.md')) return 'Google Antigravity';
  if (allParts.some(p => p === '.claude' || p === 'claude.md')) return 'Claude Code';
  if (allParts.some(p => p === '.codex' || p === '.codex-evidence')) return 'Codex';
  if (allParts.some(p => p === 'opencode' || p === '.opencode' || p === 'opencode.json')) return 'OpenCode';
  if (allParts.some(p => p === '.agents' || p === 'agents.md')) return '.agents (general)';
  return undefined;
}
