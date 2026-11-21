import { extractDynamicWarnings, extractRenderedCustomTags, isRenderedInContent } from './rendered-components';
import { readSourceSnapshot } from '../source-file';
import { moduleDirective } from '../parsers/ts-syntax';
import { collectVueDynamicTreeInputs, inspectVueTreeInput } from './vue-tree-input';
import { existsSync } from "node:fs";
import { basename, dirname, extname, normalize, relative, resolve } from "node:path";
import { collectFiles } from "../collector";
import { getCandidateNames } from "../template";
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
} from "../resolver";
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
  ContextDependencyGraph,
  ContextDependencyNode,
  ContextDependencyRelation,
  PropsDrillingAlert,
} from "../../types";
import {
  findProjectRoot,
  isPageFile,
  isPathInScope,
  normalizeScopeFilters,
} from "./path-helpers";
import { extractImports } from './path-helpers';
import { autoComponentCandidates, buildAutoComponentCatalog, collectJsxComponentUses, isJsxComponentFile, jsxImportSites, resolveComponentImport } from './component-relationships';
import {
  extractPassedProps,
  detectPropsDrilling,
} from "./props-drilling";
import { createHookContextAnalyzer } from './hook-context';

// Compatibility exports for callers of the existing graph facade.
export * from './rendered-components';

export { normalizeScopeFilters, isPathInScope } from './path-helpers';

/**
 * Resolves downward component hierarchy tree starting from a root page or layout.
 */
export async function getDownwardComponentTree(
  options: ComponentTreeOptions & { entryPath: string }
): Promise<ComponentTreeResult> {
  const entryPath = resolve(options.entryPath);
  const maxDepth =
    typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth) && options.maxDepth >= 1
      ? Math.floor(options.maxDepth)
      : 3;
  const scopeFilters = normalizeScopeFilters(options.scopeFilter);

  const projectRoot = options.targetPath ? resolve(options.targetPath) : findProjectRoot(entryPath);
  const explicitAliases = options.aliasMap ? createAliasConfig(options.aliasMap, projectRoot) : null;
  const catalog = buildAutoComponentCatalog(await collectFiles(projectRoot));

  const allComponents = new Set<string>();
  const diagnostics: NonNullable<ComponentTreeResult['diagnostics']> = [];
  let maxDepthReached = 0;

  const allProviders: ContextDependencyNode[] = [];
  const allConsumers: ContextDependencyNode[] = [];
  const contextRelations: ContextDependencyRelation[] = [];
  const danglingConsumers: ContextDependencyRelation[] = [];
  const analyzeContexts = createHookContextAnalyzer(mergeAliasConfigs(explicitAliases, await loadAliasConfig(entryPath)));



  async function buildSubTree(
    filePath: string,
    depth: number,
    visitedInBranch: Set<string>,
    availableProviders: ContextDependencyNode[] = [],
    isClientParent: boolean = false
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

    if (!isInDomain) {
      diagnostics.push({ code: 'SCOPE_BOUNDARY', filePath: normPath, sourceHash: null, depth,
        reason: 'Node was not expanded because it is outside the requested scope filter.' });
      return node;
    }
    if (depth >= maxDepth) {
      diagnostics.push({ code: 'MAX_DEPTH_REACHED', filePath: normPath, sourceHash: null, depth,
        reason: `Node was not expanded because max depth ${maxDepth} was reached; further dependencies were not inspected.` });
      return node;
    }

    let content = '';
    let sourceHash = '';
    try {
      const source = await readSourceSnapshot(normPath);
      content = source.content;
      sourceHash = source.snapshot.sha256;
    } catch (error) {
      diagnostics.push({ code: 'SOURCE_READ_FAILED', filePath: normPath, sourceHash: null, depth,
        reason: `Node source could not be captured: ${error instanceof Error ? error.message : String(error)}` });
      return node;
    }

    if (extname(normPath).toLowerCase() === '.vue') {
      const issue = inspectVueTreeInput(content, normPath);
      if (issue) {
        diagnostics.push({ ...issue, filePath: normPath, sourceHash, depth });
        return node;
      }
      for (const input of collectVueDynamicTreeInputs(content, normPath)) {
        diagnostics.push({ code: 'VUE_DYNAMIC_COMPONENT', filePath: normPath, sourceHash, depth,
          expression: input.expression, selectorKind: input.kind, argument: input.argument, resolution: 'candidate',
          sourceRef: { sha256: sourceHash, startOffset: input.startOffset, endOffset: input.endOffset },
          reason: input.kind === 'dynamic-argument' || input.kind === 'object-binding'
            ? `Component ${input.kind} '${input.expression}' may supply the 'is' selector; its keys and runtime target are not resolved.`
            : `Component ${input.kind} selector '${input.expression}' requires review; this inventory does not establish its runtime target.` });
      }
    }

    const hasUseClient = /\.[jt]sx?$/.test(normPath) && Boolean(moduleDirective(content, 'use client'));
    if (isClientParent && !hasUseClient) {
      node.transitiveBoundary = 'client-hydrated (inherited from parent)';
    }
    const currentBranchIsClient = hasUseClient || isClientParent;

    // Extract Context Nodes (Vue provide/inject & React Context)
    const { providers: localProviders, consumers: localConsumers } = await analyzeContexts(normPath, content);
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

    const allImports = extractImports(content, normPath);
    const aliasConfig = mergeAliasConfigs(explicitAliases, await loadAliasConfig(normPath));
    const jsxUses = isJsxComponentFile(normPath) ? collectJsxComponentUses(normPath, content, aliasConfig) : undefined;
    const imports = allImports.filter(i => i.source.startsWith('.') || i.source.startsWith('/') || aliasConfig?.isAlias(i.source));
    const resolvedChildren = new Set<string>();

    // 1. Static and dynamic imports
    for (const imp of imports) {
      const { target: resolved } = resolveComponentImport(normPath, imp.source, imp.exportedName ?? imp.name, aliasConfig);
      const identifier = imp.alias || imp.name;
      const jsxSites = jsxImportSites(jsxUses, imp, resolved);
      const rendered = jsxSites ? jsxSites.size > 0 : isRenderedInContent(content, identifier);
      if (!resolved) {
        if (rendered) {
          diagnostics.push({
            code: 'UNRESOLVED_RENDERED_IMPORT', filePath: normPath, sourceHash,
            specifier: imp.source, identifier, resolution: 'unresolved',
            reason: `Rendered binding '${identifier}' imports '${imp.source}', which the local resolver could not resolve.`,
          });
        }
        continue;
      }

      if (!rendered) continue;

      const childNorm = normalize(resolved);
      resolvedChildren.add(childNorm);
      const passedProps = extractPassedProps(content, getCandidateNames(identifier), jsxSites);

      // Prevent infinite loops on circular dependencies in the current branch
      if (!visitedInBranch.has(childNorm)) {
        const childNode = await buildSubTree(
          childNorm,
          depth + 1,
          new Set(visitedInBranch),
          currentAvailableProviders,
          currentBranchIsClient
        );
        childNode.alias = imp.alias;
        childNode.isDynamic = imp.isDynamic;

        if (passedProps.length > 0) {
          childNode.passedProps = passedProps;
          if (passedProps.some((p) => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind')) {
            childNode.isCascadingWrapper = true;
          }
        }

        node.children.push(childNode);
      } else {
        diagnostics.push({ code: 'CYCLE_TRUNCATED', filePath: normPath, sourceHash,
          targetPath: childNorm, depth: depth + 1,
          reason: `Traversal stopped at '${childNorm}' because this file already occurs in the current branch.` });
        node.children.push({
          component: imp.alias || imp.name,
          filePath: childNorm,
          alias: imp.alias,
          isDynamic: imp.isDynamic,
          isPage: isPageFile(childNorm),
          isCircular: true,
          depth: depth + 1,
          passedProps: passedProps.length > 0 ? passedProps : undefined,
          children: [],
        });
      }
    }

    // 2. Auto-import resolution fallback for template tags not in imports
    const customTags = extractRenderedCustomTags(content);
    for (const tag of customTags) {
      const candidates = autoComponentCandidates(normPath, tag, allImports, catalog);
      if (candidates.length > 1) {
        diagnostics.push({ code: 'AMBIGUOUS_COMPONENT', filePath: normPath, sourceHash,
          identifier: tag, candidates, reason: 'Multiple auto-import candidates match this component tag.' });
      }
      const catalogTarget = candidates.length === 1 ? candidates[0] : undefined;
      if (catalogTarget && !resolvedChildren.has(catalogTarget)) {
        resolvedChildren.add(catalogTarget);
        if (!visitedInBranch.has(catalogTarget)) {
          const childNode = await buildSubTree(
            catalogTarget,
            depth + 1,
            new Set(visitedInBranch),
            currentAvailableProviders,
            currentBranchIsClient
          );
          childNode.isAutoImported = true;

          const candidateNames = getCandidateNames(tag);
          const passedProps = extractPassedProps(content, candidateNames);
          if (passedProps.length > 0) {
            childNode.passedProps = passedProps;
            if (passedProps.some((p) => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind')) {
              childNode.isCascadingWrapper = true;
            }
          }

          node.children.push(childNode);
        } else {
          diagnostics.push({ code: 'CYCLE_TRUNCATED', filePath: normPath, sourceHash,
            targetPath: catalogTarget, depth: depth + 1,
            reason: `Traversal stopped at '${catalogTarget}' because this file already occurs in the current branch.` });
          const candidateNames = getCandidateNames(tag);
          const passedProps = extractPassedProps(content, candidateNames);
          node.children.push({
            component: tag,
            filePath: catalogTarget,
            isAutoImported: true,
            isCircular: true,
            isPage: isPageFile(catalogTarget),
            depth: depth + 1,
            passedProps: passedProps.length > 0 ? passedProps : undefined,
            children: [],
          });
        }
      }
    }

const VUE_NUXT_BUILTIN_TAGS = new Set([
  'teleport',
  'suspense',
  'keep-alive',
  'keepalive',
  'transition',
  'transition-group',
  'transitiongroup',
  'nuxt-link',
  'nuxtlink',
  'client-only',
  'clientonly',
  'dev-only',
  'devonly',
  'nuxt-page',
  'nuxtpage',
  'nuxt-layout',
  'nuxtlayout',
  'nuxt-loading-indicator',
  'nuxtloadingindicator',
  'nuxt-error-boundary',
  'nuxterrorboundary',
  'nuxt-img',
  'nuxtimg',
  'nuxt-picture',
  'nuxtpicture',
]);

    // 3. Static external/unresolved tags are not dynamic components; actual dynamic
    // components (<component :is="..."> or local variable/computed tags) are handled in step 4.

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
    diagnostics,
    propsDrilling: detectPropsDrilling(rootNode),
    contextGraph,
  };
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
      if (node.isCascadingWrapper) label += ` [cascading-wrapper: spread]`;
      if (node.isDynamic && !node.warning) label += ` [dynamic/lazy]`;
      if (node.isAutoImported) label += ` [auto-imported]`;
      if (node.isPage) label += ` [Page]`;
      if (node.isRendered === false || node.relationKind === 'import') label += ` [import-only]`;
      if (node.transitiveBoundary) label += ` [${node.transitiveBoundary}]`;
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

  if (result.diagnostics?.length) {
    const rootDir = dirname(result.root.filePath);
    const shortPath = (filePath: string) => {
      const rel = relative(rootDir, filePath);
      return rel && !rel.startsWith('..') ? rel : filePath;
    };
    output += '\n\nTraversal diagnostics (partial resolution):';
    const maxDepthItems = result.diagnostics.filter((d) => d.code === 'MAX_DEPTH_REACHED');
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.code === 'MAX_DEPTH_REACHED') continue;
      output += `\n  ${diagnostic.code}: ${diagnostic.reason} (${shortPath(diagnostic.filePath)}; source SHA-256: ${diagnostic.sourceHash ?? 'not-captured'})`;
    }
    if (maxDepthItems.length === 1) {
      const d = maxDepthItems[0];
      output += `\n  ${d.code}: ${d.reason} (${shortPath(d.filePath)}; source SHA-256: ${d.sourceHash ?? 'not-captured'})`;
    } else if (maxDepthItems.length > 1) {
      const uniqueNames = [...new Set(maxDepthItems.map((d) => basename(d.filePath)))];
      const shown = uniqueNames.slice(0, 5).join(', ');
      const extra = uniqueNames.length > 5 ? `, +${uniqueNames.length - 5} more` : '';
      output += `\n  MAX_DEPTH_REACHED: ${maxDepthItems.length} node(s) at depth ${result.maxDepthReached} not expanded (${shown}${extra})`;
    }
  }

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

/**
 * Formats a component tree result as a standard Mermaid flowchart diagram.
 */
export function formatTreeAsMermaid(result: ComponentTreeResult): string {
  const isUpward = result.direction === 'upward';
  const lines: string[] = ['graph TD'];
  const nodeMap = new Map<ComponentTreeNode, string>();
  let counter = 0;

  function sanitize(str: string): string {
    return str.replace(/"/g, "'").replace(/[<>]/g, '');
  }

  function getNodeId(node: ComponentTreeNode): string {
    let id = nodeMap.get(node);
    if (!id) {
      id = `n${counter++}`;
      nodeMap.set(node, id);
    }
    return id;
  }

  function buildNodeLabel(node: ComponentTreeNode, isRoot: boolean): string {
    let label = sanitize(node.component);
    if (isRoot) {
      label += isUpward ? ' (Target)' : ' (Root)';
    } else {
      if (node.alias) label += ` (${sanitize(node.alias)})`;
      if (node.isPage) label += ' [Page]';
    }
    return label;
  }

  function traverse(node: ComponentTreeNode, isRoot = true) {
    const parentId = getNodeId(node);
    if (isRoot) {
      lines.push(`  ${parentId}["${buildNodeLabel(node, true)}"]:::rootNode`);
    }

    for (const child of node.children || []) {
      const childId = getNodeId(child);
      const childLabel = buildNodeLabel(child, false);
      const isDynamic = child.isDynamic;
      const isImportOnly = child.isRendered === false || child.relationKind === 'import';

      lines.push(`  ${childId}["${childLabel}"]`);

      let edgeLabel = '';
      if (child.isCascadingWrapper) {
        edgeLabel = '|"...spread"|';
      } else if (child.passedProps && child.passedProps.length > 0) {
        const propNames = child.passedProps.slice(0, 2).map((p) => p.propName).join(', ');
        const extra = child.passedProps.length > 2 ? '...' : '';
        edgeLabel = `|"${propNames}${extra}"|`;
      } else if (isImportOnly) {
        edgeLabel = '|"import"|';
      }

      if (isDynamic) {
        lines.push(`  ${parentId} -.->${edgeLabel} ${childId}`);
      } else {
        lines.push(`  ${parentId} -->${edgeLabel} ${childId}`);
      }

      traverse(child, false);
    }
  }

  traverse(result.root);
  lines.push('  classDef rootNode fill:#4f46e5,stroke:#3730a3,color:#fff,stroke-width:2px;');

  return lines.join('\n');
}
