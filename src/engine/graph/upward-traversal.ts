import { readSourceSnapshot } from '../source-file';
import { inspectVueTreeInput } from './vue-tree-input';
import { extractImports } from './path-helpers';
import { extractPassedProps } from './props-drilling';
import { existsSync, promises as fs, statSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { collectFiles } from "../collector";
import { getCandidateNames, isComponentNameMatch } from "../template";
import { escapeRegExp } from "../patterns";
import {
  createAliasConfig,
  loadAliasConfig,
  mergeAliasConfigs,
  type AliasConfig,
} from "../resolver";
import { getWorkspaceDatabase } from "../database";
import { isWorkspaceIndexed } from '../storage/schema';
import { queryUpwardBlastRadiusFromDb } from '../storage/blast-radius';
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
  ContextDependencyGraph,
  ContextDependencyNode,
  ContextDependencyRelation,
  EdgePayload,
  PassedPropInfo,
} from "../../types";
import {
  findProjectRoot,
  isPageFile,
  resolveImportPath,
  resolveBarrelExport,
} from "./path-helpers";
import {
  normalizeScopeFilters,
  isPathInScope,
  isRenderedInContent,
} from "./downward-traversal";


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
  const limit = options.limit !== undefined ? options.limit : 20;
  const projectRoot = options.targetPath ? normalize(resolve(options.targetPath)) : findProjectRoot(entryPath);
  const diagnostics: NonNullable<ComponentTreeResult['diagnostics']> = [];

  // Fast Indexed Lookup via SQLite Graph DB (Reverse Dependency Indexing with cycle & limit detection)
  if (isWorkspaceIndexed(projectRoot)) {
    try {
      const db = getWorkspaceDatabase(projectRoot);
      const targetFile = db.query('SELECT id, is_page FROM files WHERE path = ?').get(normalize(entryPath)) as { id: number; is_page: number } | null;
      if (targetFile) {
        const edgeCount = (db.query('SELECT count(*) as count FROM edges WHERE child_file_id = ?').get(targetFile.id) as { count: number } | null)?.count ?? 0;
        if (edgeCount > 0) {
          const allConsumers = new Set<string>();
          let maxDepthReached = 0;
          let hasMore = false;
          const scopeFilters = normalizeScopeFilters(options.scopeFilter);

          const getParentEdges = db.prepare(`
            SELECT p.path, p.is_page, e.import_type, e.is_rendered, f.content_hash
            FROM edges e
            JOIN files p ON e.parent_file_id = p.id
            LEFT JOIN files f ON f.path = p.path
            WHERE e.child_file_id = ?
            ORDER BY p.path ASC
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

            const parents = getParentEdges.all(fileId) as Array<{ path: string; is_page: number; import_type: string; is_rendered: number; content_hash: string | null }>;
            for (const parent of parents) {
              if (allConsumers.size >= limit + 1) {
                hasMore = true;
                break;
              }
              const parentPath = normalize(parent.path);
              const parentIsPage = parent.is_page === 1;
              const isRendered = parent.is_rendered === 1;
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
                  relationKind,
                  children: [],
                });
                continue;
              }

              const parentFile = db.query('SELECT id FROM files WHERE path = ?').get(parentPath) as { id: number } | null;
              if (parentFile) {
                const parentNode = buildDbSubTree(parentPath, parentFile.id, parentIsPage, depth + 1, new Set(visitedInBranch));
                parentNode.isRendered = isRendered;
                parentNode.relationKind = relationKind;
                node.children.push(parentNode);
              }
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
      }
    } catch {
      // Fallback to dynamic scan if database query encounters an issue
    }
  }

  const allFiles = (await collectFiles(projectRoot)).sort();

  const autoDetectedAliases = await loadAliasConfig(entryPath);
  const explicitAliases = options.aliasMap
    ? createAliasConfig(options.aliasMap, projectRoot)
    : null;
  const aliasConfig = mergeAliasConfigs(explicitAliases, autoDetectedAliases);

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

  // Index component candidate names to detect collisions for auto-import resolution
  const candidateToFileMap = new Map<string, string[]>();
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (ext === '.vue' || ext === '.astro' || ext === '.svelte' || ext === '.tsx' || ext === '.jsx') {
      const base = basename(file, ext);
      for (const cand of getCandidateNames(base)) {
        const key = cand.toLowerCase();
        const list = candidateToFileMap.get(key) || [];
        if (!list.includes(normalize(file))) list.push(normalize(file));
        candidateToFileMap.set(key, list);
      }
    }
  }

  // Checks if sourceFile directly imports or references targetPath
  function fileConsumesTarget(
    sourceFile: string,
    sourceContent: string,
    targetPath: string
  ): {
    consumes: boolean;
    isRendered: boolean;
    relationKind: 'render' | 'import' | 'type';
    passedProps?: PassedPropInfo[];
    isCascadingWrapper?: boolean;
  } | null {
    if (sourceFile === targetPath) return null;

    // Check 1: Static and dynamic imports in source
    const imports = extractImports(sourceContent, sourceFile);
    const explicitlyBoundNames = new Set<string>();

    for (const imp of imports) {
      const isLocal = imp.source.startsWith('.') || imp.source.startsWith('/') || aliasConfig?.isAlias(imp.source);
      let resolved = isLocal ? resolveImportPath(sourceFile, imp.source, aliasConfig) : null;
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
          const isRendered = isRenderedInContent(sourceContent, imp.alias || imp.name);
          const candidateNames = getCandidateNames(imp.alias || imp.name);
          const passedProps = extractPassedProps(sourceContent, candidateNames);
          const isCascadingWrapper = passedProps.some((p) => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind');
          return {
            consumes: true,
            isRendered,
            relationKind: isRendered ? 'render' : 'import',
            passedProps: passedProps.length > 0 ? passedProps : undefined,
            isCascadingWrapper: isCascadingWrapper || undefined,
          };
        }
      }
      const boundName = imp.alias || imp.name;
      if (boundName && boundName !== '*') {
        for (const cand of getCandidateNames(boundName)) explicitlyBoundNames.add(cand.toLowerCase());
      }
    }

    // Check 2: Template / JSX auto-import or direct tag references
    // Only valid if:
    // 1. The tag is NOT explicitly imported from another file
    // 2. The component name uniquely resolves to targetPath in the project without collision
    const targetBase = basename(targetPath, extname(targetPath));
    const candidateNames = getCandidateNames(targetBase);
    for (const cand of candidateNames) {
      if (explicitlyBoundNames.has(cand.toLowerCase())) {
        continue;
      }
      const matchingFiles = candidateToFileMap.get(cand.toLowerCase()) || [];
      if (matchingFiles.length > 1) {
        // Collision: multiple components have this candidate name, requires explicit import
        continue;
      }
      if (matchingFiles.length === 1 && matchingFiles[0] !== targetPath) {
        continue;
      }

      if (isRenderedInContent(sourceContent, cand)) {
        const passedProps = extractPassedProps(sourceContent, [cand]);
        const isCascadingWrapper = passedProps.some((p) => p.isSpread || p.propName === '...spread' || p.propName === '...v-bind');
        return {
          consumes: true,
          isRendered: true,
          relationKind: 'render',
          passedProps: passedProps.length > 0 ? passedProps : undefined,
          isCascadingWrapper: isCascadingWrapper || undefined,
        };
      }
    }

    return null;
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

    for (const [sourceFile, sourceContent] of fileContents) {
      if (allConsumers.size >= limit + 1) {
        hasMore = true;
        break;
      }
      const consumption = fileConsumesTarget(sourceFile, sourceContent, normPath);
      if (consumption) {
        if (visitedInBranch.has(sourceFile)) {
          diagnostics.push({ code: 'CYCLE_TRUNCATED', filePath: sourceFile, sourceHash: fileHashes.get(sourceFile)!,
            targetPath: sourceFile, depth: depth + 1,
            reason: `Upward traversal stopped at consumer '${sourceFile}' of '${normPath}' because this consumer already occurs in the current branch.` });
          node.children.push({ component: getDisambiguatedComponentName(sourceFile, isPageFile(sourceFile)),
            filePath: sourceFile, isPage: isPageFile(sourceFile), isCircular: true, depth: depth + 1,
            isRendered: consumption.isRendered, relationKind: consumption.relationKind, children: [] });
          continue;
        }
        const parentNode = await buildUpwardSubTree(
          sourceFile,
          depth + 1,
          new Set(visitedInBranch)
        );
        parentNode.isRendered = consumption.isRendered;
        parentNode.relationKind = consumption.relationKind;
        if (consumption.passedProps) parentNode.passedProps = consumption.passedProps;
        if (consumption.isCascadingWrapper) parentNode.isCascadingWrapper = true;
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
    has_more: hasMore,
    diagnostics,
    propsDrilling: [],
  };
}
