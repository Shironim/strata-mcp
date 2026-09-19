import { existsSync, promises as fs, statSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { parse as parseDom, NodeTypes } from "@vue/compiler-dom";
import ts from "typescript";
import { collectFiles } from "../collector";
import { getCandidateNames, isComponentNameMatch } from "../template";
import { escapeRegExp } from "../patterns";
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  type AliasConfig,
} from "../resolver";
import { resolveRouteEntry } from "../routes";
import { getWorkspaceDatabase } from "../database";
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
  ContextDependencyGraph,
  ContextDependencyNode,
  ContextDependencyRelation,
  EdgePayload,
  PassedPropInfo,
  PropsDrillingAlert,
} from "../../types";
import { walkVueDom, extractVueTemplate } from "./ast-helpers";
import {
  findProjectRoot,
  isPageFile,
  resolveImportPath,
  resolveBarrelExport,
  extractLocalImports,
} from "./resolution";
import {
  extractPassedProps,
  detectPropsDrilling,
} from "./props-drilling";
import { extractComponentContextNodes } from "./context-analyzer";
import { getUpwardComponentTree } from "./upward-traversal";

export interface DynamicComponentWarning {
  component: string;
  warning: string;
}

/**
 * Extracts custom component tags rendered in a template or JSX (e.g. <AppHeader>, <app-button>).
 * Also resolves dynamic components rendered via Vue/Nuxt `<component :is="...">` and dictionary maps.
 */
/**
 * Helper to resolve component references from an object literal dictionary in TypeScript AST.
 */
export function extractDictionaryComponentsFromTsAst(sourceFile: ts.SourceFile, dictVarName: string, tags: Set<string>): void {
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === dictVarName) {
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
            const compName = prop.initializer.text;
            if (/^[A-Z][A-Za-z0-9_$]*$/.test(compName)) {
              tags.add(compName);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
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
 * Also resolves dynamic components rendered via Vue/Nuxt `<component :is="...">` and dictionary maps
 * using official AST traversals (@vue/compiler-dom and TypeScript Compiler API).
 */
export function extractRenderedCustomTags(content: string): string[] {
  const tags = new Set<string>();

  // 1. Vue/Nuxt AST traversal via @vue/compiler-dom
  const vueTemplate = extractVueTemplate(content);
  const templateSource = vueTemplate ?? (/<[A-Za-z]/.test(content) && !content.includes('export default') ? content : null);

  let sourceFile: ts.SourceFile | null = null;
  const getTsSourceFile = () => {
    if (!sourceFile) {
      let scriptCode = content;
      if (content.includes('<script')) {
        const scriptMatches = Array.from(content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
        if (scriptMatches.length > 0) {
          scriptCode = scriptMatches.map((m) => m[1]).join('\n');
        }
      }
      sourceFile = ts.createSourceFile('component.tsx', scriptCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    }
    return sourceFile;
  };

  if (templateSource) {
    try {
      const ast = parseDom(templateSource, { comments: false });
      walkVueDom(ast, (el) => {
        if (el.tag === 'component') {
          // Dynamic component: <component :is="...">
          for (const prop of el.props) {
            if (
              prop.type === NodeTypes.DIRECTIVE &&
              prop.name === 'bind' &&
              prop.arg &&
              'content' in prop.arg &&
              prop.arg.content === 'is' &&
              prop.exp &&
              'content' in prop.exp
            ) {
              const exp = prop.exp.content.trim();
              const directMatch = exp.match(/^([A-Z][A-Za-z0-9_$]*)$/);
              if (directMatch) {
                tags.add(directMatch[1]);
              } else {
                const mapMatch = exp.match(/^([A-Za-z0-9_$]+)(?:\[|\.)/);
                if (mapMatch) {
                  extractDictionaryComponentsFromTsAst(getTsSourceFile(), mapMatch[1], tags);
                }
              }
            }
          }
        } else if (
          /^[A-Z][A-Za-z0-9_]*$/.test(el.tag) ||
          /^[a-z][a-z0-9_]*-[a-z0-9_-]*$/.test(el.tag)
        ) {
          tags.add(el.tag);
        }
      });
    } catch {
      // Fall through to JS/TS AST and fallback regex if template parsing errors
    }
  }

  // 2. React / JSX / Astro AST traversal via TypeScript AST
  try {
    const sf = getTsSourceFile();
    function visit(node: ts.Node) {
      // JSX opening & self-closing elements: <ProductCard ... />
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName)) {
          const name = node.tagName.text;
          if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) {
            tags.add(name);
          }
        } else if (ts.isPropertyAccessExpression(node.tagName)) {
          const fullName = node.tagName.getText(sf);
          if (/^[A-Z]/.test(fullName)) {
            tags.add(fullName);
          }
        }
      }

      // React dynamic component assignment: const SelectedWidget = WIDGETS[type];
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z][A-Za-z0-9_$]*$/.test(node.name.text)) {
        if (node.initializer && ts.isElementAccessExpression(node.initializer)) {
          if (ts.isIdentifier(node.initializer.expression)) {
            const mapVarName = node.initializer.expression.text;
            extractDictionaryComponentsFromTsAst(sf, mapVarName, tags);
          }
        }
      }

      // React.createElement or jsx/jsxs call: createElement(DynamicModal, ...)
      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(sf);
        if (
          calleeText === 'createElement' ||
          calleeText === 'React.createElement' ||
          calleeText === 'jsx' ||
          calleeText === 'jsxs' ||
          calleeText.endsWith('.createElement')
        ) {
          if (node.arguments.length > 0 && ts.isIdentifier(node.arguments[0])) {
            const compName = node.arguments[0].text;
            if (/^[A-Z][A-Za-z0-9_$]*$/.test(compName)) {
              tags.add(compName);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(sf);
  } catch {
    // Fallback if AST generation fails
  }

  // 3. Resilient fallback for standalone raw fragments
  const tagRegex = /<([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9_]*-[a-z0-9_-]*)/g;
  for (const match of content.matchAll(tagRegex)) {
    tags.add(match[1]);
  }

  return Array.from(tags);
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
 * Checks if a single candidate name appears as a rendered tag, `:is` binding, or inside a dynamic map
 * by querying AST-extracted tags from extractRenderedCustomTags.
 */
export function isCandidateRendered(content: string, candidate: string): boolean {
  const renderedTags = extractRenderedCustomTags(content);
  for (const tag of renderedTags) {
    if (isComponentNameMatch(tag, candidate)) return true;
    // Support namespaced and dot-access components: <COMPONENT_MAP.candidate /> or <UI.Button />
    const lastPart = tag.split('.').pop();
    if (lastPart && isComponentNameMatch(lastPart, candidate)) return true;
  }

  // Resilient fallback for direct literal tag or :is string literal
  const fastTagPattern = new RegExp(
    `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(candidate)}[\\s/>]|:is=['"]${escapeRegExp(candidate)}['"]`,
    'i'
  );
  return fastTagPattern.test(content);
}

/**
 * Checks if a component identifier or candidate alias is actually rendered in the file's template/JSX.
 */
export function isRenderedInContent(content: string, identifier: string): boolean {
  return getCandidateNames(identifier).some((candidate) => isCandidateRendered(content, candidate));
}

export function normalizeScopeFilters(filter?: string | string[]): string[] {
  if (!filter) return [];
  const arr = Array.isArray(filter) ? filter : [filter];
  return arr.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
}

export function isPathInScope(filePath: string, scopeFilters: string[]): boolean {
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

  const allProviders: ContextDependencyNode[] = [];
  const allConsumers: ContextDependencyNode[] = [];
  const contextRelations: ContextDependencyRelation[] = [];
  const danglingConsumers: ContextDependencyRelation[] = [];

  // ---------------------------------------------------------------------------
  // 1. FAST PATH: SQLite In-Memory / WAL Graph Traversal (Recursive CTE)
  // ---------------------------------------------------------------------------
  try {
    const db = getWorkspaceDatabase(projectRoot);
    const normEntry = normalize(entryPath);
    const rootRow = db
      .prepare('SELECT id, path, is_page FROM files WHERE path = ?')
      .get(normEntry) as { id: number; path: string; is_page: number } | undefined;

    if (rootRow) {
      const rows = db
        .prepare(`
          WITH RECURSIVE hierarchy(id, parent_id, depth) AS (
            SELECT id, NULL, 0 FROM files WHERE path = $entryPath
            UNION ALL
            SELECT e.child_file_id, e.parent_file_id, h.depth + 1
            FROM edges e
            JOIN hierarchy h ON e.parent_file_id = h.id
            WHERE h.depth < $maxDepth AND e.is_rendered = 1
          )
          SELECT
            h.depth,
            p.path AS parent_path,
            c.path AS child_path,
            c.is_page,
            e.import_type,
            e.payload_json
          FROM hierarchy h
          JOIN edges e ON h.id = e.child_file_id AND h.parent_id = e.parent_file_id
          JOIN files c ON e.child_file_id = c.id
          JOIN files p ON e.parent_file_id = p.id
          ORDER BY h.depth ASC;
        `)
        .all({ $entryPath: normEntry, $maxDepth: maxDepth }) as Array<{
          depth: number;
          parent_path: string;
          child_path: string;
          is_page: number;
          import_type: string;
          payload_json: string | null;
        }>;

      if (rows.length > 0) {
        const rootNode: ComponentTreeNode = {
          component: basename(rootRow.path),
          filePath: rootRow.path,
          depth: 0,
          isPage: Boolean(rootRow.is_page),
          children: [],
        };

        const nodeMap = new Map<string, ComponentTreeNode>();
        nodeMap.set(normEntry, rootNode);
        const componentsSet = new Set<string>([normEntry]);
        let maxDepthFound = 0;

        const fastProviders: ContextDependencyNode[] = [];
        const fastConsumers: ContextDependencyNode[] = [];
        const fastContextRelations: ContextDependencyRelation[] = [];
        const fastDanglingConsumers: ContextDependencyRelation[] = [];

        for (const row of rows) {
          const parentNode = nodeMap.get(row.parent_path);
          if (!parentNode) continue;

          if (row.depth > maxDepthFound) maxDepthFound = row.depth;
          componentsSet.add(row.child_path);

          let payload: EdgePayload | null = null;
          if (row.payload_json) {
            try {
              payload = JSON.parse(row.payload_json);
            } catch {
              // ignore malformed payload
            }
          }

          if (payload?.contexts?.provided) {
            fastProviders.push(...payload.contexts.provided);
          }
          if (payload?.contexts?.consumed) {
            fastConsumers.push(...payload.contexts.consumed);
          }

          const childNode: ComponentTreeNode = {
            component: basename(row.child_path),
            filePath: row.child_path,
            depth: row.depth,
            isPage: Boolean(row.is_page),
            isDynamic: row.import_type === 'dynamic' ? true : undefined,
            passedProps: payload?.passedProps,
            children: [],
          };

          parentNode.children.push(childNode);
          nodeMap.set(row.child_path, childNode);
        }

        for (const consumer of fastConsumers) {
          const matchedProvider = fastProviders.find((p) => p.key === consumer.key);
          if (matchedProvider) {
            fastContextRelations.push({
              key: consumer.key,
              provider: matchedProvider,
              consumer,
              isCoveredInTree: true,
            });
          } else {
            const rel: ContextDependencyRelation = {
              key: consumer.key,
              consumer,
              isCoveredInTree: false,
              warning: `Context key '${consumer.key}' consumed in '${consumer.component}' has no matching Provider in this hierarchy branch.`,
            };
            fastContextRelations.push(rel);
            fastDanglingConsumers.push(rel);
          }
        }

        const contextGraph: ContextDependencyGraph = {
          providers: fastProviders,
          consumers: fastConsumers,
          relations: fastContextRelations,
          danglingConsumers: fastDanglingConsumers,
        };

        return {
          root: rootNode,
          totalComponents: componentsSet.size,
          maxDepthReached: maxDepthFound,
          direction: 'downward',
          propsDrilling: detectPropsDrilling(rootNode),
          contextGraph,
        };
      }
    }
  } catch {
    // Fallback gracefully to disk traversal if SQLite query fails or table missing
  }

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
