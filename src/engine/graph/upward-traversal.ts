import { readSourceFile } from '../source-file';
import { extractImports } from './path-helpers';
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
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
  ContextDependencyGraph,
  ContextDependencyNode,
  ContextDependencyRelation,
  EdgePayload,
} from "../../types";
import {
  findProjectRoot,
  isPageFile,
  resolveImportPath,
  resolveBarrelExport,
} from "./resolution";
import {
  normalizeScopeFilters,
  isPathInScope,
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
  const projectRoot = options.targetPath ? normalize(resolve(options.targetPath)) : findProjectRoot(entryPath);
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
        const content = await readSourceFile(file);
        fileContents.set(normalize(file), content);
      } catch {
        // ignore
      }
    }
  }

  // Index component candidate names to detect collisions for auto-import resolution
  const candidateToFileMap = new Map<string, string[]>();
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (ext === '.vue' || ext === '.astro' || ext === '.tsx' || ext === '.jsx') {
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
  ): boolean {
    if (sourceFile === targetPath) return false;

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
          return true;
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
