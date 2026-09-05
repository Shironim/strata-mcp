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
  ContextDependencyGraph,
  ContextDependencyNode,
  ContextDependencyRelation,
  PassedPropInfo,
  PropsDrillingAlert,
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
const INLINE_ASYNC_COMPONENT_PATTERN =
  /([A-Za-z0-9_$]+)\s*:\s*(?:defineAsyncComponent|lazy|dynamic)\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;

import { findProjectRoot } from './path-resolver';
export { findProjectRoot };

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
 * Also resolves dynamic components rendered via Vue/Nuxt `<component :is="...">` and dictionary maps.
 */
export function extractRenderedCustomTags(content: string): string[] {
  const tags = new Set<string>();
  const tagRegex = /<([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9_]*-[a-z0-9_-]*)/g;
  for (const match of content.matchAll(tagRegex)) {
    tags.add(match[1]);
  }

  // 1. Vue/Nuxt dynamic component: <component :is="DirectComponent" />
  const directIsRegex = /<component\s+[^>]*?(?::|v-bind:)is=["']([A-Z][A-Za-z0-9_$]*)["']/g;
  for (const m of content.matchAll(directIsRegex)) {
    tags.add(m[1]);
  }

  // 2. Vue/Nuxt dynamic component map: <component :is="mapVar[key]" /> or :is="mapVar.key"
  const dynamicMapRegex = /<component\s+[^>]*?(?::|v-bind:)is=["']([A-Za-z0-9_$]+)(?:\[|\.)/g;
  for (const m of content.matchAll(dynamicMapRegex)) {
    const mapVarName = m[1];
    const dictDeclRegex = new RegExp(
      `(?:const|let|var)\\s+${escapeRegExp(mapVarName)}\\s*(?::\\s*[^=]+)?=\\s*\\{([\\s\\S]*?)\\}`,
      'm'
    );
    const dictMatch = content.match(dictDeclRegex);
    if (dictMatch && dictMatch[1]) {
      const dictBody = dictMatch[1];
      const valueRegex = /:\s*([A-Z][A-Za-z0-9_$]*)/g;
      for (const vm of dictBody.matchAll(valueRegex)) {
        tags.add(vm[1]);
      }
    }
  }

  // 3. React / Next.js / Astro dynamic component map: const DynamicComp = mapVar[key]; ... <DynamicComp
  const reactMapRegex = /(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*([A-Za-z0-9_$]+)\[/g;
  for (const rm of content.matchAll(reactMapRegex)) {
    const renderedVar = rm[1];
    const mapVarName = rm[2];
    if (new RegExp(`<${escapeRegExp(renderedVar)}[\\s/>]`).test(content)) {
      const dictDeclRegex = new RegExp(
        `(?:const|let|var)\\s+${escapeRegExp(mapVarName)}\\s*(?::\\s*[^=]+)?=\\s*\\{([\\s\\S]*?)\\}`,
        'm'
      );
      const dictMatch = content.match(dictDeclRegex);
      if (dictMatch && dictMatch[1]) {
        const dictBody = dictMatch[1];
        const valueRegex = /:\s*([A-Z][A-Za-z0-9_$]*)/g;
        for (const vm of dictBody.matchAll(valueRegex)) {
          tags.add(vm[1]);
        }
      }
    }
  }

  // 4. React createElement / jsx runtime: createElement(Component) or jsx(Component)
  const createElementRegex = /\b(?:React\.createElement|createElement|jsx|jsxs)\(\s*([A-Z][A-Za-z0-9_$]*)/g;
  for (const cm of content.matchAll(createElementRegex)) {
    tags.add(cm[1]);
  }

  return Array.from(tags);
}

export interface DynamicComponentWarning {
  component: string;
  warning: string;
}

/**
 * Extracts warnings for dynamic or polymorphic components that cannot be statically resolved.
 */
export function extractDynamicWarnings(
  content: string,
  resolvedCustomTags: Set<string>
): DynamicComponentWarning[] {
  const warnings: DynamicComponentWarning[] = [];

  // 1. Vue dynamic component: <component :is="expr" /> where expr is not resolved statically
  const anyIsRegex = /<component\s+[^>]*?(?::|v-bind:)is=["']([^"']+)["']/g;
  for (const m of content.matchAll(anyIsRegex)) {
    const rawExpr = m[1].trim();
    if (!resolvedCustomTags.has(rawExpr)) {
      warnings.push({
        component: `<component :is="${rawExpr}">`,
        warning: `Dynamic/polymorphic component (:is="${rawExpr}") cannot be statically resolved`,
      });
    }
  }

  // 2. Radix UI / Headless / Polymorphic asChild pattern
  const asChildRegex = /<([A-Z][A-Za-z0-9_.]*)\s+[^>]*?\basChild\b/g;
  for (const m of content.matchAll(asChildRegex)) {
    warnings.push({
      component: `<${m[1]} asChild>`,
      warning: `Polymorphic delegate component (<${m[1]} asChild>) cannot be statically resolved`,
    });
  }

  return warnings;
}

/**
 * Extracts props and dynamic bindings passed to child components in a template or JSX.
 */
export function extractPassedProps(parentContent: string, componentNames: string[]): PassedPropInfo[] {
  const passedProps: PassedPropInfo[] = [];
  const seenProps = new Set<string>();

  for (const name of componentNames) {
    const tagRegex = new RegExp(`<${escapeRegExp(name)}([\\s\\S]*?)(?:\\/?>|>)`, 'i');
    const match = parentContent.match(tagRegex);
    if (!match) continue;

    const attributesBlock = match[1];

    // 1. Dynamic bindings: :propName="expression" or v-bind:propName="expression"
    const dynamicBindingRegex = /(?::|v-bind:)([A-Za-z0-9_-]+)=["']([^"']+)["']/g;
    for (const b of attributesBlock.matchAll(dynamicBindingRegex)) {
      const propName = b[1];
      const expression = b[2].trim();
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression });
      }
    }

    // 2. Two-way bindings: v-model="expression" or v-model:propName="expression"
    const vModelRegex = /v-model(?::([A-Za-z0-9_-]+))?=["']([^"']+)["']/g;
    for (const b of attributesBlock.matchAll(vModelRegex)) {
      const propName = b[1] ? `v-model:${b[1]}` : 'v-model';
      const expression = b[2].trim();
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression });
      }
    }

    // 3. Static string attributes (excluding non-prop HTML standard attributes)
    const staticPropRegex = /\b([A-Za-z0-9_-]+)=["']([^"']+)["']/g;
    for (const s of attributesBlock.matchAll(staticPropRegex)) {
      const propName = s[1];
      if (
        propName.startsWith(':') ||
        propName.startsWith('v-') ||
        propName.startsWith('@') ||
        ['class', 'style', 'id', 'ref', 'key'].includes(propName)
      ) {
        continue;
      }
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression: `"${s[2]}"` });
      }
    }
  }

  return passedProps;
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

  const inlineDynamicMatches = content.matchAll(INLINE_ASYNC_COMPONENT_PATTERN);
  for (const m of inlineDynamicMatches) {
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
 * Checks if a single candidate name appears as a rendered tag, `:is` binding, or inside a dynamic map.
 */
function isCandidateRendered(content: string, candidate: string): boolean {
  // 1. Direct tag (<Candidate or <Namespace.Candidate) or Vue :is string literal
  const tagPattern = new RegExp(
    `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(candidate)}[\\s/>]|:is=['"]${escapeRegExp(candidate)}['"]`
  );
  if (tagPattern.test(content)) {
    return true;
  }

  // 2. Vue/Nuxt dynamic component :is binding (e.g. <component :is="mapVar[key]" />)
  if (/(?::|v-bind:)is=/.test(content)) {
    const objValPattern = new RegExp(
      `(?::\\s*|{\\s*|,\\s*)${escapeRegExp(candidate)}\\s*[,}]`
    );
    if (objValPattern.test(content)) {
      return true;
    }
  }

  // 3. React / Next.js / Astro dynamic component map: const Comp = mapVar[key]; <Comp ... />
  const dynamicJsxVarRegex = /(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*([A-Za-z0-9_$]+)\[/g;
  for (const match of content.matchAll(dynamicJsxVarRegex)) {
    const jsxVar = match[1];
    const mapName = match[2];
    if (new RegExp(`<${escapeRegExp(jsxVar)}[\\s/>]`).test(content)) {
      const mapDeclRegex = new RegExp(
        `(?:const|let|var)\\s+${escapeRegExp(mapName)}\\s*(?::\\s*[^=]+)?=\\s*\\{[\\s\\S]*?\\b${escapeRegExp(candidate)}\\b[\\s\\S]*?\\}`
      );
      if (mapDeclRegex.test(content)) {
        return true;
      }
    }
  }

  // 4. Direct JSX map property access: <COMPONENT_MAP.candidate /> or <map.Candidate />
  const dotAccessPattern = new RegExp(
    `<[A-Za-z0-9_$]+\\.${escapeRegExp(candidate)}[\\s/>]`
  );
  if (dotAccessPattern.test(content)) {
    return true;
  }

  // 5. React.createElement / jsx(Candidate)
  const createElementPattern = new RegExp(
    `\\b(?:React\\.createElement|createElement|jsx|jsxs)\\(\\s*${escapeRegExp(candidate)}\\b`
  );
  if (createElementPattern.test(content)) {
    return true;
  }

  return false;
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

interface PropTracker {
  propName: string;
  expression: string;
  originComponent: string;
  drilledThrough: string[];
}

/**
 * Traverses the resolved component tree to identify props forwarded through
 * 1 or more intermediate components without local consumption or transformation.
 */
export function detectPropsDrilling(root: ComponentTreeNode): PropsDrillingAlert[] {
  const alerts: PropsDrillingAlert[] = [];
  const seen = new Set<string>();

  function traverse(node: ComponentTreeNode, activeChains: PropTracker[]) {
    for (const child of node.children) {
      const nextChains: PropTracker[] = [];

      if (child.passedProps && child.passedProps.length > 0) {
        for (const p of child.passedProps) {
          const propName = p.propName;
          const expr = (p.expression || '').trim();

          // Check if this prop matches or forwards an active prop chain received by `node`
          const matchedChain = activeChains.find((c) => {
            if (c.propName === propName) return true;
            if (c.propName === expr) return true;
            if (c.expression && c.expression === expr) return true;
            if (expr.startsWith(`${c.propName}.`) || expr.startsWith(`${c.propName}[`)) return true;
            if (c.expression && (expr.startsWith(`${c.expression}.`) || expr.startsWith(`${c.expression}[`))) return true;
            return false;
          });

          if (matchedChain) {
            const drilledThrough = [...matchedChain.drilledThrough, node.component];
            const depth = drilledThrough.length + 1;

            if (depth >= 2) {
              const alertKey = `${matchedChain.originComponent}:${drilledThrough.join('>')}:${child.component}:${propName}`;
              if (!seen.has(alertKey)) {
                seen.add(alertKey);
                alerts.push({
                  prop: p.expression || propName,
                  origin: matchedChain.originComponent,
                  drilledThrough,
                  target: child.component,
                  depth,
                  recommendation:
                    depth >= 3
                      ? `Consider Pinia/Zustand or Provide/Inject to eliminate deep ${depth}-level props drilling`
                      : `Provide/Inject or Composable candidate instead of drilling through ${node.component}`,
                });
              }
            }

            nextChains.push({
              propName,
              expression: expr || matchedChain.expression,
              originComponent: matchedChain.originComponent,
              drilledThrough,
            });
          } else {
            // New prop chain originating from `node`
            nextChains.push({
              propName,
              expression: expr,
              originComponent: node.component,
              drilledThrough: [],
            });
          }
        }
      }

      traverse(child, nextChains);
    }
  }

  traverse(root, []);
  return alerts;
}

/**
 * Extracts provide/inject (Vue) and Context Provider/useContext (React) nodes from component code.
 */
export function extractComponentContextNodes(
  filePath: string,
  content: string
): { providers: ContextDependencyNode[]; consumers: ContextDependencyNode[] } {
  const providers: ContextDependencyNode[] = [];
  const consumers: ContextDependencyNode[] = [];
  const component = basename(filePath);

  const getLine = (offset: number) => {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    return line;
  };

  // 1. Vue provide: provide('key', val) or provide(KEY_SYM, val)
  const vueProvideRegex = /\bprovide\s*\(\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_$]+))\s*,\s*([^)]*)\)/g;
  for (const m of content.matchAll(vueProvideRegex)) {
    const key = m[1] || m[2];
    if (key) {
      providers.push({
        key,
        type: 'vue-provide',
        component,
        filePath,
        line: getLine(m.index || 0),
        valueSnippet: m[3]?.trim(),
      });
    }
  }

  // 2. Vue inject: inject('key') or inject(KEY_SYM)
  const vueInjectRegex = /\binject\s*(?:<[^>]+>)?\s*\(\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_$]+))\s*(?:,[^)]*)?\)/g;
  for (const m of content.matchAll(vueInjectRegex)) {
    const key = m[1] || m[2];
    if (key) {
      consumers.push({
        key,
        type: 'vue-inject',
        component,
        filePath,
        line: getLine(m.index || 0),
      });
    }
  }

  // 3. React <Context.Provider value={...}>
  const reactProviderRegex = /<([A-Za-z0-9_$]+?)(?:Context)?\.Provider\b(?:[^>]*?value=\{([^}]+)\})?/g;
  for (const m of content.matchAll(reactProviderRegex)) {
    const key = m[1].endsWith('Context') ? m[1] : `${m[1]}Context`;
    providers.push({
      key,
      type: 'react-provider',
      component,
      filePath,
      line: getLine(m.index || 0),
      valueSnippet: m[2]?.trim(),
    });
  }

  // 4. React useContext(Context)
  const reactUseContextRegex = /\buseContext\s*(?:<[^>]+>)?\s*\(\s*([A-Za-z0-9_$]+)\s*\)/g;
  for (const m of content.matchAll(reactUseContextRegex)) {
    const rawKey = m[1];
    const key = rawKey.endsWith('Context') ? rawKey : `${rawKey}Context`;
    consumers.push({
      key,
      type: 'react-use-context',
      component,
      filePath,
      line: getLine(m.index || 0),
    });
  }

  return { providers, consumers };
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

  const allProviders: ContextDependencyNode[] = [];
  const allConsumers: ContextDependencyNode[] = [];
  const contextRelations: ContextDependencyRelation[] = [];
  const danglingConsumers: ContextDependencyRelation[] = [];

  async function buildSubTree(
    filePath: string,
    depth: number,
    visitedInBranch: Set<string>,
    availableProviders: ContextDependencyNode[] = []
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

    // Extract Context Nodes (Vue provide/inject & React Context)
    const { providers: localProviders, consumers: localConsumers } = extractComponentContextNodes(normPath, content);
    allProviders.push(...localProviders);
    allConsumers.push(...localConsumers);

    const currentAvailableProviders = [...availableProviders, ...localProviders];

    for (const consumer of localConsumers) {
      const matchedProvider = currentAvailableProviders.find((p) => p.key === consumer.key);
      if (matchedProvider) {
        contextRelations.push({
          key: consumer.key,
          provider: matchedProvider,
          consumer,
          isCoveredInTree: true,
        });
      } else {
        const relation: ContextDependencyRelation = {
          key: consumer.key,
          consumer,
          isCoveredInTree: false,
          warning: `Context key '${consumer.key}' consumed in '${consumer.component}' has no matching Provider in this hierarchy branch. May cause runtime undefined context when rendered directly.`,
        };
        contextRelations.push(relation);
        danglingConsumers.push(relation);
      }
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
          new Set(visitedInBranch),
          currentAvailableProviders
        );
        childNode.alias = imp.alias;
        childNode.isDynamic = imp.isDynamic;
        childNode.isPage = isPageFile(childNorm);

        const candidateNames = getCandidateNames(imp.alias || imp.name);
        const passedProps = extractPassedProps(content, candidateNames);
        if (passedProps.length > 0) {
          childNode.passedProps = passedProps;
        }

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
            new Set(visitedInBranch),
            currentAvailableProviders
          );
          childNode.isAutoImported = true;
          childNode.isPage = isPageFile(catalogTarget);

          const candidateNames = getCandidateNames(tag);
          const passedProps = extractPassedProps(content, candidateNames);
          if (passedProps.length > 0) {
            childNode.passedProps = passedProps;
          }

          node.children.push(childNode);
        }
      }
    }

    // 3. Dynamic component fallback tags (e.g. from dynamic map evaluation)
    for (const tag of customTags) {
      const isRegistered =
        imports.some((i) => (i.alias || i.name) === tag) || catalog.has(tag.toLowerCase());
      if (isRegistered || tag.startsWith('app-') || tag.startsWith('base-')) {
        continue;
      }
      node.children.push({
        component: tag,
        filePath: 'dynamic-unresolved',
        warning: 'Dynamic component rendered via variable/computed (definition unresolved)',
        depth: depth + 1,
        children: [],
      });
    }

    // 4. Dynamic and polymorphic component warning nodes
    const dynamicWarnings = extractDynamicWarnings(content, new Set(customTags));
    for (const dyn of dynamicWarnings) {
      node.children.push({
        component: dyn.component,
        filePath: '',
        isDynamic: true,
        warning: dyn.warning,
        depth: depth + 1,
        children: [],
      });
    }

    return node;
  }

  const rootNode = await buildSubTree(entryPath, 0, new Set(), []);

  const contextGraph: ContextDependencyGraph | undefined =
    allProviders.length > 0 || allConsumers.length > 0
      ? {
          providers: allProviders,
          consumers: allConsumers,
          relations: contextRelations,
          danglingConsumers,
        }
      : undefined;

  return {
    root: rootNode,
    totalComponents: allComponents.size,
    maxDepthReached,
    direction: 'downward',
    propsDrilling: detectPropsDrilling(rootNode),
    contextGraph,
  };
}

/**
 * Resolves a disambiguated component name for upward traversal trees.
 * When a file is a page (or generic index.*), includes the domain/parent folder (e.g. "Penjualan/Index.vue").
 */
export function getDisambiguatedComponentName(filePath: string, isPage: boolean): string {
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(filePath);

  if (isPage) {
    const pageMatch = norm.match(/(?:^|\/)(?:pages|Pages|views|Views|routes)\/(.+)$/);
    if (pageMatch && pageMatch[1]) {
      return pageMatch[1];
    }
    const appMatch = norm.match(/(?:^|\/)app\/(.+)$/);
    if (appMatch && appMatch[1]) {
      return appMatch[1];
    }
    const dir = basename(dirname(filePath));
    if (dir && dir !== '.' && dir !== '/' && dir !== '\\') {
      return `${dir}/${base}`;
    }
  }

  if (/^index\.[a-z0-9]+$/i.test(base)) {
    const dir = basename(dirname(filePath));
    if (dir && dir !== '.' && dir !== '/' && dir !== '\\') {
      return `${dir}/${base}`;
    }
  }

  return base;
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
    const isPage = isPageFile(normPath);
    const componentName = depth === 0 ? basename(currentPath) : getDisambiguatedComponentName(normPath, isPage);
    allConsumers.add(normPath);
    if (depth > maxDepthReached) maxDepthReached = depth;

    visitedInBranch.add(normPath);

    const isInDomain = isPathInScope(normPath, scopeFilters);

    const node: ComponentTreeNode = {
      component: componentName,
      filePath: normPath,
      depth,
      isPage,
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
    propsDrilling: [],
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
      if (node.passedProps && node.passedProps.length > 0) {
        const propsStr = node.passedProps
          .map((p) => (p.expression ? `${p.propName} <- ${p.expression}` : p.propName))
          .join(', ');
        label += ` [props: ${propsStr}]`;
      }
      if (node.isDynamic && !node.warning) label += ` [dynamic/lazy]`;
      if (node.isAutoImported) label += ` [auto-imported]`;
      if (node.isPage) label += ` [Page]`;
      if (node.isExternalScope) label += ` [external-domain/package]`;
      if (node.warning) label += ` ⚠️ ${node.warning}`;
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
  let output = header + treeText + summary;

  if (result.propsDrilling && result.propsDrilling.length > 0) {
    output += `\n\nProps Drilling Diagnostics (${result.propsDrilling.length} detected):`;
    for (const alert of result.propsDrilling) {
      const chain = [alert.origin, ...alert.drilledThrough, alert.target].join(' ➔ ');
      output += `\n  ⚠️  [depth: ${alert.depth}] prop "${alert.prop}": ${chain}`;
      output += `\n      Recommendation: ${alert.recommendation}`;
    }
  }

  if (result.contextGraph) {
    const { providers, consumers, danglingConsumers } = result.contextGraph;
    if (providers.length > 0 || consumers.length > 0) {
      output += `\n\nImplicit Context Graph (Provide/Inject & React Context):`;
      output += `\n  - Providers declared (${providers.length}): ${providers.map((p) => `"${p.key}" in ${p.component}`).join(', ') || '(none)'}`;
      output += `\n  - Consumers injected (${consumers.length}): ${consumers.map((c) => `"${c.key}" in ${c.component}`).join(', ') || '(none)'}`;

      if (danglingConsumers.length > 0) {
        output += `\n  ⚠️  Dangling Context Warnings (${danglingConsumers.length} detected):`;
        for (const dc of danglingConsumers) {
          output += `\n      • Context "${dc.key}" consumed in ${dc.consumer.component} (Line ${dc.consumer.line}) has NO matching Provider in ancestor hierarchy!`;
        }
      }
    }
  }

  return output;
}

