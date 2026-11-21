import { extractRenderedCustomTags, isRenderedInContent } from './rendered-components';
import { readSourceSnapshot } from '../source-file';
import { inspectVueTreeInput } from './vue-tree-input';
import { extractImports } from './path-helpers';
import { autoComponentCandidates, buildAutoComponentCatalog, collectJsxComponentUses, isJsxComponentFile, jsxImportSites, resolveComponentImport } from './component-relationships';
import { extractPassedProps } from './props-drilling';
import { existsSync } from "node:fs";
import { basename, dirname, extname, normalize, resolve } from "node:path";
import { collectFiles } from "../collector";
import { getCandidateNames } from "../template";
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
} from "../resolver";
import { getWorkspaceDatabase } from "../database";
import { resolveIndexedWorkspaceRoot } from '../storage/schema';
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
  EdgePayload,
  PassedPropInfo,
} from "../../types";
import {
  findProjectRoot,
  isPageFile,
  isPathInScope,
  normalizeScopeFilters,
} from "./path-helpers";


/**
 * Resolves a disambiguated component name for upward traversal trees.
 * When a file is a page (or generic index.*), includes the domain/parent folder (e.g. "Penjualan/Index.vue").
 */
export function getDisambiguatedComponentName(filePath: string, isPage: boolean): string {
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(filePath);
  const appPrefixMatch = norm.match(/(?:^|\/)(apps\/[^/]+)\//);
  const appPrefix = appPrefixMatch ? `${appPrefixMatch[1]}/` : '';

  if (isPage) {
    const pageMatch = norm.match(/(?:^|\/)(?:pages|Pages|views|Views|routes)\/(.+)$/);
    if (pageMatch && pageMatch[1]) {
      return `${appPrefix}${pageMatch[1]}`;
    }
    const appMatch = norm.match(/(?:^|\/)app\/(.+)$/);
    if (appMatch && appMatch[1]) {
      return `${appPrefix}${appMatch[1]}`;
    }
    const dir = basename(dirname(filePath));
    if (dir && dir !== '.' && dir !== '/' && dir !== '\\') {
      return `${appPrefix}${dir}/${base}`;
    }
  }

  if (/^index\.[a-z0-9]+$/i.test(base)) {
    const dir = basename(dirname(filePath));
    if (dir && dir !== '.' && dir !== '/' && dir !== '\\') {
      return `${appPrefix}${dir}/${base}`;
    }
  }

  const appRelMatch = norm.match(/(?:^|\/)(apps\/[^/]+\/.+)$/);
  if (appRelMatch && appRelMatch[1]) {
    return appRelMatch[1];
  }

  return `${appPrefix}${base}`;
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
  const limit = options.limit !== undefined ? options.limit : 20;
  const projectRoot = options.targetPath ? normalize(resolve(options.targetPath)) : findProjectRoot(entryPath);
  if (!options.skipSync) {
    const { prepareIndexedAnalysis } = await import('../prepare-index');
    await prepareIndexedAnalysis(projectRoot, true);
  }
  const diagnostics: NonNullable<ComponentTreeResult['diagnostics']> = [];

  // Indexed reverse lookup via SQLite graph DB (Reverse Dependency Indexing with cycle & limit detection)
  if (!options.aliasMap && resolveIndexedWorkspaceRoot(projectRoot) === projectRoot) {
    try {
      const db = getWorkspaceDatabase(projectRoot);
      const targetFile = db.query('SELECT id, is_page FROM files WHERE path = ?').get(normalize(entryPath)) as { id: number; is_page: number } | null;
      if (targetFile) {
        const allConsumers = new Set<string>();
        let maxDepthReached = 0;
        let hasMore = false;
        const scopeFilters = normalizeScopeFilters(options.scopeFilter);

        const getParentEdges = db.prepare(`
          SELECT p.id, p.path, p.is_page, e.import_type, e.is_rendered, p.content_hash, e.payload_json
          FROM edges e
          JOIN files p ON e.parent_file_id = p.id
          WHERE e.child_file_id = ?
          ORDER BY p.path ASC, e.is_rendered DESC,
            CASE e.import_type WHEN 'static' THEN 0 WHEN 'dynamic' THEN 1 ELSE 2 END
        `);

        const buildDbSubTree = (
          filePath: string,
          fileId: number,
          isPage: boolean,
          depth: number,
          visitedInBranch: Set<string>
        ): ComponentTreeNode => {
          allConsumers.add(filePath);
          if (depth > maxDepthReached) maxDepthReached = depth;
          visitedInBranch.add(filePath);

          const componentName = getDisambiguatedComponentName(filePath, isPage);
          const isInDomain = isPathInScope(filePath, scopeFilters);

          const node: ComponentTreeNode = {
            component: componentName,
            filePath,
            depth,
            isPage,
            isExternalScope: !isInDomain ? true : undefined,
            children: [],
          };

          if (!isInDomain) {
            diagnostics.push({ code: 'SCOPE_BOUNDARY', filePath, sourceHash: null, depth,
              reason: 'Upward node was not expanded because it is outside the requested scope filter.' });
            return node;
          }
          if (depth >= maxDepth) {
            diagnostics.push({ code: 'MAX_DEPTH_REACHED', filePath, sourceHash: null, depth,
              reason: `Upward node was not expanded because max depth ${maxDepth} was reached; further consumers were not inspected.` });
            return node;
          }
          if (allConsumers.size >= limit + 1) {
            hasMore = true;
            diagnostics.push({ code: 'UPWARD_RESULTS_TRUNCATED', filePath, sourceHash: null, depth,
              reason: `Upward consumers limit (${limit}) reached; remaining consumers omitted.` });
            return node;
          }

          const parents = getParentEdges.all(fileId) as Array<{ id: number; path: string; is_page: number; import_type: string; is_rendered: number; content_hash: string | null; payload_json: string | null }>;
          const seenParentPaths = new Set<string>();
          for (const parent of parents) {
            const parentPath = normalize(parent.path);
            if (seenParentPaths.has(parentPath)) continue;
            seenParentPaths.add(parentPath);
            if (allConsumers.size >= limit + 1) {
              hasMore = true;
              break;
            }
            const parentIsPage = parent.is_page === 1;
            const isRendered = parent.is_rendered === 1;
            const isAutoImported = parent.import_type === 'auto' || undefined;
            const payload = parent.payload_json ? JSON.parse(parent.payload_json) as EdgePayload : undefined;
            const passedProps = payload?.passedProps;
            const isCascadingWrapper = passedProps?.some(p => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind') || undefined;
            const relationKind = parent.import_type === 'dynamic' ? 'dynamic-import' : isRendered ? 'render' : 'import';

            if (visitedInBranch.has(parentPath)) {
              diagnostics.push({
                code: 'CYCLE_TRUNCATED',
                filePath: parentPath,
                sourceHash: parent.content_hash ?? null,
                targetPath: parentPath,
                depth: depth + 1,
                reason: `Upward traversal stopped at consumer '${parentPath}' of '${filePath}' because this consumer already occurs in the current branch.`,
              });
              node.children.push({
                component: getDisambiguatedComponentName(parentPath, parentIsPage),
                filePath: parentPath,
                isPage: parentIsPage,
                isCircular: true,
                depth: depth + 1,
                isRendered,
                isAutoImported,
                passedProps,
                isCascadingWrapper,
                relationKind,
                children: [],
              });
              continue;
            }

            const parentNode = buildDbSubTree(parentPath, parent.id, parentIsPage, depth + 1, new Set(visitedInBranch));
            Object.assign(parentNode, { isRendered, relationKind, isAutoImported, passedProps, isCascadingWrapper });
            node.children.push(parentNode);
          }

          return node;
        };

        const rootNode = buildDbSubTree(normalize(entryPath), targetFile.id, targetFile.is_page === 1, 0, new Set());

        return {
          root: rootNode,
          totalComponents: allConsumers.size,
          maxDepthReached,
          direction: 'upward',
          has_more: hasMore,
          diagnostics,
          propsDrilling: [],
        };
      }
    } catch {
      // Fallback to dynamic scan if database query encounters an issue
    }
  }

  const allFiles = (await collectFiles(projectRoot)).sort();

  const explicitAliases = options.aliasMap
    ? createAliasConfig(options.aliasMap, projectRoot)
    : null;

  // Pre-load content of candidate consumer files
  const fileContents = new Map<string, string>();
  const fileHashes = new Map<string, string>();
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (
      ext === '.vue' ||
      ext === '.astro' ||
      ext === '.svelte' ||
      ext === '.tsx' ||
      ext === '.jsx' ||
      ext === '.ts' ||
      ext === '.js'
    ) {
      try {
        const { content, snapshot } = await readSourceSnapshot(file);
        if (ext === '.vue') {
          const issue = inspectVueTreeInput(content, file);
          if (issue) {
            diagnostics.push({ code: 'CONSUMER_INPUT_UNSUPPORTED', filePath: normalize(file),
              sourceHash: snapshot.sha256, reason: `${issue.code}: Candidate consumer was excluded: ${issue.reason}` });
            continue;
          }
        }
        fileContents.set(normalize(file), content);
        fileHashes.set(normalize(file), snapshot.sha256);
      } catch (error) {
        diagnostics.push({ code: 'CONSUMER_SOURCE_READ_FAILED', filePath: normalize(file), sourceHash: null,
          reason: `Candidate consumer source could not be captured during workspace discovery: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  const catalog = buildAutoComponentCatalog(allFiles);
  type Consumption = {
    isRendered: boolean;
    relationKind: 'render' | 'import' | 'dynamic-import';
    isAutoImported?: boolean;
    passedProps?: PassedPropInfo[];
    isCascadingWrapper?: boolean;
  };
  const reverse = new Map<string, Array<{ sourceFile: string; usage: Consumption }>>();
  for (const [sourceFile, content] of fileContents) {
    const aliases = mergeAliasConfigs(explicitAliases, await loadAliasConfig(sourceFile));
    const imports = extractImports(content, sourceFile);
    const jsxUses = isJsxComponentFile(sourceFile) ? collectJsxComponentUses(sourceFile, content, aliases) : undefined;
    const relationships = new Map<string, Consumption>();
    function record(target: string, tag: string, isRendered: boolean, relationKind: Consumption['relationKind'], isAutoImported?: boolean, jsxSites?: ReadonlySet<number>) {
      if (sourceFile === target || (relationships.has(target) && (!isRendered || relationships.get(target)?.isRendered))) return;
      const props = isRendered ? extractPassedProps(content, getCandidateNames(tag), jsxSites) : [];
      relationships.set(target, { isRendered, relationKind, isAutoImported, passedProps: props.length ? props : undefined,
        isCascadingWrapper: props.some(p => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind') || undefined });
    }
    for (const imp of imports.sort((a, b) => Number(a.isDynamic) - Number(b.isDynamic))) {
      const target = resolveComponentImport(sourceFile, imp.source, imp.exportedName ?? imp.name, aliases).target;
      if (!target) continue;
      const tag = imp.alias || imp.name;
      const jsxSites = jsxImportSites(jsxUses, imp, target);
      const rendered = jsxSites ? jsxSites.size > 0 : isRenderedInContent(content, tag);
      record(target, tag, rendered, imp.isDynamic ? 'dynamic-import' : rendered ? 'render' : 'import', undefined, jsxSites);
    }
    for (const tag of extractRenderedCustomTags(content)) {
      const candidates = autoComponentCandidates(sourceFile, tag, imports, catalog);
      if (candidates.length === 1) record(candidates[0], tag, true, 'render', true);
      if (candidates.length > 1 && candidates.includes(entryPath)) {
        diagnostics.push({ code: 'AMBIGUOUS_COMPONENT', filePath: sourceFile, sourceHash: fileHashes.get(normalize(sourceFile))!,
          identifier: tag, candidates, reason: 'Multiple auto-import candidates match this component tag.' });
      }
    }
    for (const [target, usage] of relationships) {
      let entries = reverse.get(target);
      if (!entries) reverse.set(target, entries = []);
      entries.push({ sourceFile, usage });
    }
  }

  const allConsumers = new Set<string>();
  let maxDepthReached = 0;
  let hasMore = false;

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

    if (!isInDomain) {
      diagnostics.push({ code: 'SCOPE_BOUNDARY', filePath: normPath, sourceHash: null, depth,
        reason: 'Upward node was not expanded because it is outside the requested scope filter.' });
      return node;
    }
    if (depth >= maxDepth) {
      diagnostics.push({ code: 'MAX_DEPTH_REACHED', filePath: normPath, sourceHash: null, depth,
        reason: `Upward node was not expanded because max depth ${maxDepth} was reached; further consumers were not inspected.` });
      return node;
    }
    if (allConsumers.size >= limit + 1) {
      hasMore = true;
      diagnostics.push({ code: 'UPWARD_RESULTS_TRUNCATED', filePath: normPath, sourceHash: null, depth,
        reason: `Upward consumers limit (${limit}) reached; remaining consumers omitted.` });
      return node;
    }

    for (const { sourceFile, usage: consumption } of reverse.get(normPath) ?? []) {
      if (allConsumers.size >= limit + 1) {
        hasMore = true;
        break;
      }
      if (visitedInBranch.has(sourceFile)) {
        diagnostics.push({ code: 'CYCLE_TRUNCATED', filePath: sourceFile, sourceHash: fileHashes.get(sourceFile)!,
          targetPath: sourceFile, depth: depth + 1,
          reason: `Upward traversal stopped at consumer '${sourceFile}' of '${normPath}' because this consumer already occurs in the current branch.` });
        node.children.push({ component: getDisambiguatedComponentName(sourceFile, isPageFile(sourceFile)),
          filePath: sourceFile, isPage: isPageFile(sourceFile), isCircular: true, depth: depth + 1,
          ...consumption, children: [] });
        continue;
      }
      const parentNode = await buildUpwardSubTree(sourceFile, depth + 1, new Set(visitedInBranch));
      Object.assign(parentNode, consumption);
      node.children.push(parentNode);
    }

    return node;
  }

  const rootNode = await buildUpwardSubTree(entryPath, 0, new Set());

  return {
    root: rootNode,
    totalComponents: allConsumers.size,
    maxDepthReached,
    direction: 'upward',
    has_more: hasMore,
    diagnostics,
    propsDrilling: [],
  };
}
