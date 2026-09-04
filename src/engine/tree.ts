import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { getCandidateNames } from './template';
import { escapeRegExp } from './patterns';
import { collectFiles } from './collector';
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  type AliasConfig,
} from './resolver';
import { resolveRouteEntry } from './routes';
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
} from '../types';

interface ExtractedImport {
  name: string;
  alias?: string;
  source: string;
  isDynamic: boolean;
}

const STATIC_IMPORT_PATTERN = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/gm;
const DEFAULT_IMPORT_CLAUSE_PATTERN = /^([A-Za-z0-9_$]+)(?:\s*,|\s*$)/;
const NAMED_IMPORT_BLOCK_PATTERN = /\{([^}]+)\}/;
const NAMED_IMPORT_ITEM_PATTERN = /^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/;
const DYNAMIC_IMPORT_PATTERN =
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:defineAsyncComponent|lazy|dynamic)\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;

/**
 * Discovers the project root directory by walking up looking for config/lock markers.
 */
export function findProjectRoot(fromPath: string): string {
  let dir = dirname(resolve(fromPath));
  const markers = [
    'package.json',
    'jsconfig.json',
    'tsconfig.json',
    'nuxt.config.ts',
    'nuxt.config.js',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'astro.config.mjs',
    'vite.config.ts',
    'vite.config.js',
    '.git',
  ];

  while (true) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirname(resolve(fromPath));
}

/**
 * Builds an index of available component files in the project for auto-import resolution.
 * Maps lowercase component names (both PascalCase and kebab-case) to their absolute file paths.
 */
export async function buildComponentCatalog(rootDir: string): Promise<Map<string, string>> {
  const catalog = new Map<string, string>();
  const files = await collectFiles(rootDir);

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (ext === '.vue' || ext === '.astro' || ext === '.tsx' || ext === '.jsx') {
      const base = basename(file, ext);
      const candidates = getCandidateNames(base);
      for (const cand of candidates) {
        const lower = cand.toLowerCase();
        if (!catalog.has(lower)) {
          catalog.set(lower, normalize(file));
        }
      }
    }
  }

  return catalog;
}

/**
 * Extracts custom component tags rendered in a template or JSX (e.g. <AppHeader>, <app-button>).
 */
export function extractRenderedCustomTags(content: string): string[] {
  const tags = new Set<string>();
  const tagRegex = /<([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9_]*-[a-z0-9_-]*)/g;
  for (const match of content.matchAll(tagRegex)) {
    tags.add(match[1]);
  }
  return Array.from(tags);
}

/**
 * Checks if a file path is a page or route file based on common framework conventions.
 */
export function isPageFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return (
    norm.includes('/pages/') ||
    norm.includes('/Pages/') ||
    norm.includes('/views/') ||
    norm.includes('/Views/') ||
    norm.includes('/routes/') ||
    (norm.includes('/app/') &&
      (norm.endsWith('/page.tsx') ||
        norm.endsWith('/page.jsx') ||
        norm.endsWith('/page.vue') ||
        norm.endsWith('/page.js')))
  );
}

/**
 * Resolves an import specifier to a physical file path.
 */
export function resolveImportPath(
  currentFile: string,
  importPath: string,
  aliasConfig?: AliasConfig | null
): string | null {
  const dir = dirname(currentFile);

  let target: string;
  if (aliasConfig && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    const mapped = aliasConfig.resolve(importPath);
    if (!mapped) return null;
    target = mapped;
  } else {
    target = resolve(dir, importPath);
  }

  const extensions = ['', '.vue', '.tsx', '.jsx', '.astro', '.ts', '.js'];
  for (const ext of extensions) {
    const candidate = target + ext;
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }

  // Check directory index files
  for (const ext of ['.vue', '.tsx', '.jsx', '.astro', '.ts', '.js']) {
    const indexCandidate = resolve(target, 'index' + ext);
    if (existsSync(indexCandidate)) {
      try {
        if (statSync(indexCandidate).isFile()) return indexCandidate;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Finds the re-export source path for a named export inside a barrel file,
 * e.g. `export { default as BaseButton } from './BaseButton.vue'`.
 */
function findBarrelReexportTarget(content: string, exportedName: string): string | null {
  const pattern = new RegExp(
    `export\\s*\\{[^}]*?\\b(?:default\\s+as\\s+)?${escapeRegExp(exportedName)}\\b[^}]*?\\}\\s*from\\s*['"]([^'"]+)['"]`,
    'm'
  );
  return content.match(pattern)?.[1] ?? null;
}

/**
 * Follows barrel file re-exports (e.g., export { default as BaseButton } from './BaseButton.vue').
 */
export function resolveBarrelExport(
  barrelFile: string,
  exportedName: string,
  aliasConfig?: AliasConfig | null
): string | null {
  if (!existsSync(barrelFile)) return null;

  try {
    const content = statSync(barrelFile).isFile() ? readFileSync(barrelFile, 'utf8') : '';
    const target = findBarrelReexportTarget(content, exportedName);
    return target ? resolveImportPath(barrelFile, target, aliasConfig) : null;
  } catch {
    // ignore
  }

  return null;
}

/**
 * Extracts local component imports (static and dynamic lazy imports) from source code.
 */
export function extractLocalImports(
  content: string,
  aliasConfig?: AliasConfig | null
): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  // 1. Static imports
  const staticImportMatches = content.matchAll(STATIC_IMPORT_PATTERN);

  for (const m of staticImportMatches) {
    const clause = m[1].trim();
    const source = m[2].trim();

    // Skip third-party packages (not relative, absolute, or a configured alias)
    const isLocal =
      source.startsWith('.') ||
      source.startsWith('/') ||
      (aliasConfig?.isAlias(source) ?? false);
    if (!isLocal) continue;

    // Default import: import ProductCard from './ProductCard.vue'
    const defaultMatch = clause.match(DEFAULT_IMPORT_CLAUSE_PATTERN);
    if (defaultMatch) {
      imports.push({
        name: defaultMatch[1],
        alias: undefined,
        source,
        isDynamic: false,
      });
    }

    // Named imports: import { BaseButton as ActionButton, StatusBadge } from './components'
    const namedBlockMatch = clause.match(NAMED_IMPORT_BLOCK_PATTERN);
    if (namedBlockMatch) {
      const items = namedBlockMatch[1].split(',');
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed.startsWith('type ')) continue;
        const asMatch = trimmed.match(NAMED_IMPORT_ITEM_PATTERN);
        if (asMatch) {
          imports.push({
            name: asMatch[1],
            alias: asMatch[2],
            source,
            isDynamic: false,
          });
        }
      }
    }
  }

  // 2. Dynamic lazy imports: defineAsyncComponent, React.lazy, dynamic(), import()
  const dynamicMatches = content.matchAll(DYNAMIC_IMPORT_PATTERN);

  for (const m of dynamicMatches) {
    const source = m[2].trim();
    const isLocal =
      source.startsWith('.') ||
      source.startsWith('/') ||
      (aliasConfig?.isAlias(source) ?? false);
    if (isLocal) {
      imports.push({
        name: m[1],
        alias: undefined,
        source,
        isDynamic: true,
      });
    }
  }

  return imports;
}

/**
 * Checks if a single candidate name appears as a rendered tag (or `:is` binding) in the content.
 */
function isCandidateRendered(content: string, candidate: string): boolean {
  const tagPattern = new RegExp(
    `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(candidate)}[\\s/>]|:is=['"]${escapeRegExp(candidate)}['"]`
  );
  return tagPattern.test(content);
}

/**
 * Checks if a component identifier or candidate alias is actually rendered in the file's template/JSX.
 */
export function isRenderedInContent(content: string, identifier: string): boolean {
  return getCandidateNames(identifier).some((candidate) => isCandidateRendered(content, candidate));
}

function normalizeScopeFilters(filter?: string | string[]): string[] {
  if (!filter) return [];
  const arr = Array.isArray(filter) ? filter : [filter];
  return arr.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
}

function isPathInScope(filePath: string, scopeFilters: string[]): boolean {
  if (scopeFilters.length === 0) return true;
  const norm = filePath.replace(/\\/g, '/');
  return scopeFilters.some((f) => norm.includes(f) || norm.startsWith(f));
}

/**
 * Resolves downward component hierarchy tree starting from a root page or layout.
 */
async function getDownwardComponentTree(
  options: ComponentTreeOptions & { entryPath: string }
): Promise<ComponentTreeResult> {
  const entryPath = resolve(options.entryPath);
  const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 3;
  const scopeFilters = normalizeScopeFilters(options.scopeFilter);

  // Discover aliases
  const autoDetectedAliases = await loadAliasConfig(entryPath);
  const explicitAliases = options.aliasMap
    ? createAliasConfig(options.aliasMap, dirname(entryPath))
    : null;
  const aliasConfig = mergeAliasConfigs(explicitAliases, autoDetectedAliases);

  // Discover project root and component catalog for auto-imports
  const projectRoot = findProjectRoot(entryPath);
  const catalog = await buildComponentCatalog(projectRoot);

  const allComponents = new Set<string>();
  let maxDepthReached = 0;

  async function buildSubTree(
    filePath: string,
    depth: number,
    visitedInBranch: Set<string>
  ): Promise<ComponentTreeNode> {
    const normPath = normalize(filePath);
    const componentName = basename(filePath);
    allComponents.add(normPath);
    if (depth > maxDepthReached) maxDepthReached = depth;

    visitedInBranch.add(normPath);

    const isInDomain = isPathInScope(normPath, scopeFilters);

    const node: ComponentTreeNode = {
      component: componentName,
      filePath: normPath,
      depth,
      isPage: isPageFile(normPath),
      isExternalScope: !isInDomain ? true : undefined,
      children: [],
    };

    if (depth >= maxDepth || !isInDomain) return node;

    let content = '';
    try {
      content = await fs.readFile(normPath, 'utf8');
    } catch {
      return node;
    }

    const imports = extractLocalImports(content, aliasConfig);
    const resolvedChildren = new Set<string>();

    // 1. Static and dynamic imports
    for (const imp of imports) {
      let resolved = resolveImportPath(normPath, imp.source, aliasConfig);
      if (!resolved) continue;

      // If resolved is a barrel file, follow the re-export to the underlying component
      if (
        resolved.endsWith('index.ts') ||
        resolved.endsWith('index.js') ||
        resolved.endsWith('index.tsx')
      ) {
        const barrelTarget = resolveBarrelExport(resolved, imp.name, aliasConfig);
        if (barrelTarget) resolved = barrelTarget;
      }

      // Check if this component or its alias is actually rendered
      const renderId = imp.alias || imp.name;
      if (!isRenderedInContent(content, renderId)) {
        continue;
      }

      const childNorm = normalize(resolved);
      resolvedChildren.add(childNorm);

      // Prevent infinite loops on circular dependencies in the current branch
      if (!visitedInBranch.has(childNorm)) {
        const childNode = await buildSubTree(
          childNorm,
          depth + 1,
          new Set(visitedInBranch)
        );
        childNode.alias = imp.alias;
        childNode.isDynamic = imp.isDynamic;
        childNode.isPage = isPageFile(childNorm);
        node.children.push(childNode);
      }
    }

    // 2. Auto-import resolution fallback for template tags not in imports
    const customTags = extractRenderedCustomTags(content);
    for (const tag of customTags) {
      const lower = tag.toLowerCase();
      const catalogTarget = catalog.get(lower);
      if (catalogTarget && catalogTarget !== normPath && !resolvedChildren.has(catalogTarget)) {
        resolvedChildren.add(catalogTarget);
        if (!visitedInBranch.has(catalogTarget)) {
          const childNode = await buildSubTree(
            catalogTarget,
            depth + 1,
            new Set(visitedInBranch)
          );
          childNode.isAutoImported = true;
          childNode.isPage = isPageFile(catalogTarget);
          node.children.push(childNode);
        }
      }
    }

    return node;
  }

  const rootNode = await buildSubTree(entryPath, 0, new Set());

  return {
    root: rootNode,
    totalComponents: allComponents.size,
    maxDepthReached,
    direction: 'downward',
  };
}

/**
 * Resolves the upward component hierarchy tree (blast radius / consumers)
 * starting from a leaf or shared component up to top-level pages and layouts.
 */
export async function getUpwardComponentTree(
  options: ComponentTreeOptions & { entryPath: string }
): Promise<ComponentTreeResult> {
  const entryPath = normalize(resolve(options.entryPath));
  if (!existsSync(entryPath)) {
    throw new Error(`Target component file not found: ${entryPath}`);
  }

  const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 3;
  const projectRoot = findProjectRoot(entryPath);
  const allFiles = await collectFiles(projectRoot);

  const autoDetectedAliases = await loadAliasConfig(entryPath);
  const explicitAliases = options.aliasMap
    ? createAliasConfig(options.aliasMap, projectRoot)
    : null;
  const aliasConfig = mergeAliasConfigs(explicitAliases, autoDetectedAliases);

  // Pre-load content of candidate consumer files
  const fileContents = new Map<string, string>();
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (
      ext === '.vue' ||
      ext === '.astro' ||
      ext === '.tsx' ||
      ext === '.jsx' ||
      ext === '.ts' ||
      ext === '.js'
    ) {
      try {
        const content = await fs.readFile(file, 'utf8');
        fileContents.set(normalize(file), content);
      } catch {
        // ignore
      }
    }
  }

  // Checks if sourceFile directly imports or references targetPath
  function fileConsumesTarget(
    sourceFile: string,
    sourceContent: string,
    targetPath: string
  ): boolean {
    if (sourceFile === targetPath) return false;

    // Check 1: Static and dynamic imports in source
    const imports = extractLocalImports(sourceContent, aliasConfig);
    for (const imp of imports) {
      let resolved = resolveImportPath(sourceFile, imp.source, aliasConfig);
      if (resolved) {
        if (
          resolved.endsWith('index.ts') ||
          resolved.endsWith('index.js') ||
          resolved.endsWith('index.tsx')
        ) {
          const barrelTarget = resolveBarrelExport(resolved, imp.name, aliasConfig);
          if (barrelTarget) resolved = barrelTarget;
        }
        if (normalize(resolved) === targetPath) {
          return true;
        }
      }
    }

    // Check 2: Template / JSX auto-import or direct tag references
    const targetBase = basename(targetPath, extname(targetPath));
    const candidateNames = getCandidateNames(targetBase);
    for (const cand of candidateNames) {
      const tagPattern = new RegExp(
        `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(cand)}[\\s/>]|:is=['"]${escapeRegExp(cand)}['"]`
      );
      if (tagPattern.test(sourceContent)) {
        return true;
      }
    }

    return false;
  }

  const allConsumers = new Set<string>();
  let maxDepthReached = 0;

  const scopeFilters = normalizeScopeFilters(options.scopeFilter);

  async function buildUpwardSubTree(
    currentPath: string,
    depth: number,
    visitedInBranch: Set<string>
  ): Promise<ComponentTreeNode> {
    const normPath = normalize(currentPath);
    const componentName = basename(currentPath);
    allConsumers.add(normPath);
    if (depth > maxDepthReached) maxDepthReached = depth;

    visitedInBranch.add(normPath);

    const isInDomain = isPathInScope(normPath, scopeFilters);

    const node: ComponentTreeNode = {
      component: componentName,
      filePath: normPath,
      depth,
      isPage: isPageFile(normPath),
      isExternalScope: !isInDomain ? true : undefined,
      children: [],
    };

    if (depth >= maxDepth || !isInDomain) return node;

    for (const [sourceFile, sourceContent] of fileContents) {
      if (visitedInBranch.has(sourceFile)) continue;

      if (fileConsumesTarget(sourceFile, sourceContent, normPath)) {
        const parentNode = await buildUpwardSubTree(
          sourceFile,
          depth + 1,
          new Set(visitedInBranch)
        );
        node.children.push(parentNode);
      }
    }

    return node;
  }

  const rootNode = await buildUpwardSubTree(entryPath, 0, new Set());

  return {
    root: rootNode,
    totalComponents: allConsumers.size,
    maxDepthReached,
    direction: 'upward',
  };
}

/**
 * Resolves the component hierarchy tree starting from a root/target file or route path.
 * Supports both downward (root -> children) and upward (leaf -> consumers) directions.
 */
export async function getComponentTree(
  options: ComponentTreeOptions
): Promise<ComponentTreeResult> {
  let entryPath: string;
  let resolvedRouteInfo: ComponentTreeResult['resolvedRoute'] | undefined;

  if (options.routePath) {
    const targetPath = resolve(options.targetPath || '.');
    const routeResolution = await resolveRouteEntry(targetPath, options.routePath);
    if (!routeResolution.matched || !routeResolution.filePath) {
      const avail =
        routeResolution.availableRoutes && routeResolution.availableRoutes.length > 0
          ? `\nAvailable routes:\n  ${routeResolution.availableRoutes.slice(0, 20).join('\n  ')}`
          : '';
      throw new Error(
        `Route "${options.routePath}" could not be resolved in "${targetPath}".${avail}`
      );
    }

    entryPath = resolve(routeResolution.filePath);
    resolvedRouteInfo = {
      routePath: options.routePath,
      matchedRoute: routeResolution.matchedPattern || options.routePath,
      filePath: routeResolution.filePath,
      framework: routeResolution.framework || 'unknown',
      layouts: routeResolution.layouts,
    };
  } else if (options.entryPath) {
    entryPath = resolve(options.entryPath);
  } else {
    throw new Error('Either "entryPath" or "routePath" must be provided to getComponentTree.');
  }

  if (!existsSync(entryPath)) {
    throw new Error(`Entry component file not found: ${entryPath}`);
  }

  const effectiveOptions: ComponentTreeOptions & { entryPath: string } = {
    ...options,
    entryPath,
  };

  const result =
    options.direction === 'upward'
      ? await getUpwardComponentTree(effectiveOptions)
      : await getDownwardComponentTree(effectiveOptions);

  if (resolvedRouteInfo) {
    result.resolvedRoute = resolvedRouteInfo;
  }

  return result;
}

/**
 * Formats a ComponentTreeResult into a human-readable ASCII indented tree.
 */
export function formatTreeAsText(result: ComponentTreeResult): string {
  const isUpward = result.direction === 'upward';
  let header = '';

  if (result.resolvedRoute) {
    header += `Route: ${result.resolvedRoute.routePath} (Matched: ${result.resolvedRoute.matchedRoute})\n`;
    header += `File: ${result.resolvedRoute.filePath}\n`;
    header += `Framework: ${result.resolvedRoute.framework}\n`;
    if (result.resolvedRoute.layouts && result.resolvedRoute.layouts.length > 0) {
      header += `Layouts: ${result.resolvedRoute.layouts.join(', ')}\n`;
    }
    header += '\n';
  }

  function renderNode(
    node: ComponentTreeNode,
    prefix: string = '',
    isLast: boolean = true,
    isRoot: boolean = true
  ): string {
    let text = '';
    if (isRoot) {
      text += isUpward
        ? `${node.component} (Target Component - Upward Blast Radius)\n`
        : `${node.component} (Root Page)\n`;
    } else {
      const branch = isLast ? '└── ' : '├── ';
      let label = node.component;
      if (node.alias) label += ` (alias: ${node.alias})`;
      if (node.isDynamic) label += ` [dynamic/lazy]`;
      if (node.isAutoImported) label += ` [auto-imported]`;
      if (node.isPage) label += ` [Page]`;
      if (node.isExternalScope) label += ` [external-domain/package]`;
      text += `${prefix}${branch}${label}\n`;
    }

    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isChildLast = i === node.children.length - 1;
      text += renderNode(child, childPrefix, isChildLast, false);
    }

    return text;
  }

  const treeText = renderNode(result.root);
  const summaryType = isUpward ? 'consumers' : 'components';
  const summary = `\nSummary: ${result.totalComponents} ${summaryType} explored, max depth: ${result.maxDepthReached}`;
  return header + treeText + summary;
}

