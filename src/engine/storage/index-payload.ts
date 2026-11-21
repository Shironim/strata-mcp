import { createHash } from 'node:crypto';
import { readSourceFile } from '../source-file';
import { parseVueSource } from '../vue-parser';
import { basename, dirname, extname, resolve } from 'node:path';
import {
  extractComponentContract,
  extractRenderBoundary,
} from '../contract';
import { extractImports } from '../graph/path-helpers';
import { autoComponentCandidates, buildAutoComponentCatalog, collectJsxComponentUses, isJsxComponentFile, jsxImportSites, resolveComponentImport } from '../graph/component-relationships';
import { extractPassedProps } from '../graph/props-drilling';
import { extractComponentContextNodes } from '../graph/context-analyzer';
import { extractRenderedCustomTags, isRenderedInContent } from '../graph/rendered-components';
import { loadAliasConfig } from '../resolver';
import { canonicalizePath } from '../path-resolver';
import { getCandidateNames } from '../template';
import { scanRoutes } from '../routes';
import { isPageFile } from '../routing/file-role';
import type {
  ComponentContract,
  FrontendFramework,
  EdgePayload,
  InputDependency,
  StateDependencyInfo,
} from '../../types';

export interface ParsedFilePayload {
  path: string;
  framework: string;
  isPage: boolean;
  boundary: { boundary: string; directive?: string };
  stateDeps: StateDependencyInfo;
  compName: string;
  contract: ComponentContract | null;
  edges: Array<{ targetPath: string; isDynamic: boolean; isRendered: boolean; isAutoImported?: boolean; payload?: EdgePayload }>;
  dependencies?: InputDependency[];
}

export interface ParsedWorkspaceBatch {
  files: Map<string, ParsedFilePayload>;
  routes: Awaited<ReturnType<typeof scanRoutes>> | null;
}

/**
 * Parses changed/added files in-memory for contracts, boundaries, state dependencies, and edges.
 */
export async function batchParser(
  toProcess: string[],
  absRoot: string,
  diskMap: Map<string, { fullPath: string; mtime: number; size: number }>,
  includeRoutes = true,
  catalog = buildAutoComponentCatalog(diskMap.keys()),
): Promise<ParsedWorkspaceBatch> {
  const parsedFiles = new Map<string, ParsedFilePayload>();

  for (const path of toProcess) {
    try {
      const content = await readSourceFile(path);
      if (extname(path) === '.vue') {
        const { errors } = parseVueSource(content, { filename: path, sourceMap: false });
        if (errors.length) throw new Error(`PARSE_FAILED: ${path}: ${errors.map(error => typeof error === 'string' ? error : error.message).join('; ')}`);
      }
      const contract = await extractComponentContract(path, content, { path, workspaceRoot: absRoot });
      const framework = contract.framework as FrontendFramework | 'vue-composable';
      const stateDeps = contract.stateDependencies ?? { stores: [], contexts: [], composables: [] };
      const compName = contract.component;
      const boundary = contract?.renderBoundary ?? extractRenderBoundary(path, content, framework, contract?.projectContext);
      const aliasConfig = await loadAliasConfig(path);
      const allImports = extractImports(content, path);
      const jsxUses = isJsxComponentFile(path) ? collectJsxComponentUses(path, content, aliasConfig) : undefined;
      const { providers, consumers } = extractComponentContextNodes(path, content);

      const fileDependencies: InputDependency[] = contract?.dependencies ? [...contract.dependencies] : [];
      const edges: ParsedFilePayload['edges'] = [];
      for (const imp of allImports) {
        const { target: matchedPath, barrel: barrelPath } = resolveComponentImport(path, imp.source, imp.exportedName ?? imp.name, aliasConfig);

        // If this import was resolved through a barrel file, record the barrel file as a dependency
        if (barrelPath && barrelPath !== matchedPath) {
          try {
            const bCode = await readSourceFile(barrelPath);
            const bHash = createHash('sha256').update(bCode).digest('hex');
            if (!fileDependencies.some(d => d.path === barrelPath)) {
              fileDependencies.push({ path: barrelPath, hash: bHash, isExternal: false });
            }
          } catch {}
        }

        // If import cannot be resolved to an existing file, record prospective candidate paths as unresolved dependencies
        if (!matchedPath) {
          let potentialTarget: string | null = null;
          if (imp.source.startsWith('.')) {
            potentialTarget = resolve(dirname(path), imp.source);
          } else if (aliasConfig && aliasConfig.isAlias(imp.source)) {
            potentialTarget = aliasConfig.resolve(imp.source);
          }
          if (potentialTarget) {
            const candidateExtensions = [
              '', '.vue', '.tsx', '.jsx', '.astro', '.svelte', '.ts', '.js',
              '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.vue',
            ];
            for (const ext of candidateExtensions) {
              const cand = canonicalizePath(potentialTarget + ext);
              if (!fileDependencies.some(d => d.path === cand)) {
                fileDependencies.push({ path: cand, hash: '', isExternal: false });
              }
            }
          }
        }

        if (matchedPath) {
          const tag = imp.alias || imp.name || basename(matchedPath, extname(matchedPath));
          const jsxSites = jsxImportSites(jsxUses, imp, matchedPath);
          const isRendered = jsxSites ? jsxSites.size > 0 : isRenderedInContent(content, tag);
          const passedProps = isRendered ? extractPassedProps(content, getCandidateNames(tag), jsxSites) : [];

          edges.push({
            targetPath: matchedPath,
            isDynamic: imp.isDynamic ?? false,
            isRendered,
            payload: {
              alias: imp.alias,
              passedProps: passedProps.length > 0 ? passedProps : undefined,
              contexts: (providers.length > 0 || consumers.length > 0) ? {
                provided: providers.length > 0 ? providers : undefined,
                consumed: consumers.length > 0 ? consumers : undefined,
              } : undefined,
            },
          });
        }
      }

      if (/\.(vue|astro|svelte)$/i.test(path)) {
        for (const tag of extractRenderedCustomTags(content)) {
          const candidates = autoComponentCandidates(path, tag, allImports, catalog);
          if (candidates.length !== 1) continue;
          const passedProps = extractPassedProps(content, getCandidateNames(tag));
          edges.push({ targetPath: candidates[0], isDynamic: false, isRendered: true, isAutoImported: true,
            payload: { passedProps: passedProps.length ? passedProps : undefined } });
        }
      }

      parsedFiles.set(path, {
        path,
        framework,
        isPage: isPageFile(path, contract.projectContext),
        boundary,
        stateDeps,
        compName,
        contract,
        edges,
        dependencies: fileDependencies.length > 0 ? fileDependencies : undefined,
      });
    } catch (err) {
      throw new Error(`PARSE_FAILED: ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let routeManifest: Awaited<ReturnType<typeof scanRoutes>> | null = null;
  if (includeRoutes) {
    const manifest = await scanRoutes({ targetPath: absRoot });
    routeManifest = manifest;
  }

  return {
    files: parsedFiles,
    routes: routeManifest,
  };
}
