import { parseTypeScript } from '../source-parser';
import { readSourceSnapshot } from '../source-file';
import { moduleDirective } from '../parsers/ts-syntax';
import { collectVueDynamicTreeInputs, inspectVueTreeInput } from './vue-tree-input';
import { existsSync, promises as fs, statSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { parse as parseDom, NodeTypes } from "@vue/compiler-dom";
import ts from "typescript";
import { collectFiles } from "../collector";
import { getCandidateNames, isComponentNameMatch, toKebabCase } from "../template";
import { escapeRegExp } from "../patterns";
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  type AliasConfig,
} from "../resolver";
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
  isSameMonorepoBoundary,
  resolveImportPath,
  resolveBarrelExport,
} from "./path-helpers";
import { extractImports } from './path-helpers';
import {
  extractPassedProps,
  detectPropsDrilling,
} from "./props-drilling";
import { extractComponentContextNodes } from "./context-analyzer";

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
    if (ext === '.vue' || ext === '.astro' || ext === '.svelte' || ext === '.tsx' || ext === '.jsx') {
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
function resolveDynamicComponentTag(
  prop: any,
  getTsSourceFile: () => ts.SourceFile,
  tags: Set<string>
): void {
  if (
    prop.type !== NodeTypes.DIRECTIVE ||
    prop.name !== 'bind' ||
    !prop.arg ||
    !('content' in prop.arg) ||
    prop.arg.content !== 'is' ||
    !prop.exp ||
    !('content' in prop.exp)
  ) {
    return;
  }

  const exp = prop.exp.content.trim();
  const directMatch = exp.match(/^([A-Z][A-Za-z0-9_$]*)$/);
  if (directMatch) {
    tags.add(directMatch[1]);
    return;
  }

  const mapMatch = exp.match(/^([A-Za-z0-9_$]+)(?:\[|\.)/);
  if (mapMatch) {
    extractDictionaryComponentsFromTsAst(getTsSourceFile(), mapMatch[1], tags);
  }
}

const HTML_COMMENT_RE = new RegExp('<' + '!--[\\s\\S]*?-->', 'g');
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const DOUBLE_QUOTE_RE = /"[^"\\]*(?:\\.[^"\\]*)*"/g;
const SINGLE_QUOTE_RE = /'[^'\\]*(?:\\.[^'\\]*)*'/g;

function sanitizeTemplateContent(raw: string): string {
  return raw
    .replace(HTML_COMMENT_RE, '')
    .replace(BLOCK_COMMENT_RE, '')
    .replace(LINE_COMMENT_RE, '')
    .replace(DOUBLE_QUOTE_RE, '')
    .replace(SINGLE_QUOTE_RE, '');
}

/**
 * Traverses Vue/Nuxt SFC template AST, TSX JSX elements, and Astro component templates
 * to extract all rendered child custom component tags with 100% precision.
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
      sourceFile = parseTypeScript('component.tsx', scriptCode, ts.ScriptKind.TSX);
    }
    return sourceFile;
  };

  if (templateSource) {
    try {
      const ast = parseDom(templateSource, { comments: false });
      walkVueDom(ast, (el) => {
        if (el.tag === 'component') {
          for (const prop of el.props) {
            resolveDynamicComponentTag(prop, getTsSourceFile, tags);
          }
          return;
        }

        if (
          /^[A-Z][A-Za-z0-9_.]*$/.test(el.tag) ||
          /^[a-z][a-z0-9_]*-[a-z0-9_.-]*$/.test(el.tag)
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

  // 3. Resilient fallback for standalone raw fragments (only if no SFC template is present)
  if (vueTemplate === null) {
    const sanitized = sanitizeTemplateContent(content);
    const tagRegex = /<([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9_]*-[a-z0-9_-]*)/g;
    for (const match of sanitized.matchAll(tagRegex)) {
      tags.add(match[1]);
    }
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

  // If Vue template was present, AST traversal via @vue/compiler-dom is authoritative
  const vueTemplate = extractVueTemplate(content);
  if (vueTemplate !== null) {
    return false;
  }

  // Resilient fallback for non-SFC / raw template fragments, but strip comments and strings first
  const sanitized = sanitizeTemplateContent(content);

  const fastTagPattern = new RegExp(
    `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(candidate)}[\\s/>]|:is=['"]${escapeRegExp(candidate)}['"]`,
    'i'
  );
  return fastTagPattern.test(sanitized);
}

/** Normalize once per file for workspace audits; namespaced renders also expose their final name. */
export function renderedComponentKeys(content: string): Set<string> {
  const tags = extractRenderedCustomTags(content);
  if (extractVueTemplate(content) === null) {
    for (const match of sanitizeTemplateContent(content).matchAll(/<([A-Za-z0-9_$.]+)(?=[\s/>])/g)) tags.push(match[1]);
  }
  return new Set(tags.flatMap(tag => {
    const last = tag.split('.').pop()!;
    return [`case:${tag.toLowerCase()}`, `kebab:${toKebabCase(tag)}`, `case:${last.toLowerCase()}`, `kebab:${toKebabCase(last)}`];
  }));
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
export async function getDownwardComponentTree(
  options: ComponentTreeOptions & { entryPath: string }
): Promise<ComponentTreeResult> {
  const entryPath = resolve(options.entryPath);
  const maxDepth =
    typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth) && options.maxDepth >= 1
      ? Math.floor(options.maxDepth)
      : 3;
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
  const diagnostics: NonNullable<ComponentTreeResult['diagnostics']> = [];
  let maxDepthReached = 0;

  const allProviders: ContextDependencyNode[] = [];
  const allConsumers: ContextDependencyNode[] = [];
  const contextRelations: ContextDependencyRelation[] = [];
  const danglingConsumers: ContextDependencyRelation[] = [];



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

    const allImports = extractImports(content, normPath);
    const imports = allImports.filter(i => i.source.startsWith('.') || i.source.startsWith('/') || aliasConfig?.isAlias(i.source));
    const resolvedChildren = new Set<string>();

    // 1. Static and dynamic imports
    for (const imp of imports) {
      let resolved = resolveImportPath(normPath, imp.source, aliasConfig);
      if (!resolved) {
        const identifier = imp.alias || imp.name;
        if (isRenderedInContent(content, identifier)) {
          diagnostics.push({
            code: 'UNRESOLVED_RENDERED_IMPORT', filePath: normPath, sourceHash,
            specifier: imp.source, identifier, resolution: 'unresolved',
            reason: `Rendered binding '${identifier}' imports '${imp.source}', which the local resolver could not resolve.`,
          });
        }
        continue;
      }

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
          currentAvailableProviders,
          currentBranchIsClient
        );
        childNode.alias = imp.alias;
        childNode.isDynamic = imp.isDynamic;
        childNode.isPage = isPageFile(childNorm);

        const candidateNames = getCandidateNames(imp.alias || imp.name);
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
          targetPath: childNorm, depth: depth + 1,
          reason: `Traversal stopped at '${childNorm}' because this file already occurs in the current branch.` });
        const candidateNames = getCandidateNames(imp.alias || imp.name);
        const passedProps = extractPassedProps(content, candidateNames);
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
      if (allImports.some(i => isComponentNameMatch(tag, i.alias || i.name))) continue;
      const lower = tag.toLowerCase();
      const catalogTarget = catalog.get(lower);
      if (
        catalogTarget &&
        catalogTarget !== normPath &&
        isSameMonorepoBoundary(normPath, catalogTarget) &&
        !resolvedChildren.has(catalogTarget)
      ) {
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
          childNode.isPage = isPageFile(catalogTarget);

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
