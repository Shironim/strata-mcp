import { readSourceFile } from '../source-file';
import { parseVueSource } from '../vue-parser';
import { Database } from 'bun:sqlite';
import { basename, extname, normalize, resolve } from 'node:path';
import {
  detectFramework,
  extractComponentContract,
  extractRenderBoundary,
  extractStateDependencies,
} from '../contract';
import {
  extractLocalImports,
  isPageFile,
  extractPassedProps,
  extractComponentContextNodes,
  resolveImportPath,
  resolveBarrelExport,
} from '../tree';
import { loadAliasConfig } from '../resolver';
import { canonicalizePath } from '../path-resolver';
import { getCandidateNames } from '../template';
import { scanRoutes } from '../routes';
import { getWorkspaceDatabase } from './schema';
import type {
  ComponentContract,
  EdgePayload,
  StateDependencyInfo,
  SyncStats,
} from '../../types';

export interface ParsedFilePayload {
  path: string;
  framework: string;
  boundary: { boundary: string; directive?: string };
  stateDeps: StateDependencyInfo;
  compName: string;
  contract: ComponentContract | null;
  edges: Array<{ targetPath: string; isDynamic: boolean; payload?: EdgePayload }>;
}

export interface ParsedWorkspaceBatch {
  files: Map<string, ParsedFilePayload>;
  routes: Awaited<ReturnType<typeof scanRoutes>> | null;
}

/**
 * 2. Parses changed/added files in-memory for contracts, boundaries, state dependencies, and edges.
 */
export async function batchParser(
  toProcess: string[],
  absRoot: string,
  _diskMap: Map<string, { fullPath: string; mtime: number; size: number }>,
  includeRoutes = true
): Promise<ParsedWorkspaceBatch> {
  const parsedFiles = new Map<string, ParsedFilePayload>();

  for (const path of toProcess) {
    try {
      const content = await readSourceFile(path);
      if (extname(path) === '.vue') {
        const { errors } = parseVueSource(content, { filename: path, sourceMap: false });
        if (errors.length) throw new Error(`PARSE_FAILED: ${path}: ${errors.map(error => typeof error === 'string' ? error : error.message).join('; ')}`);
      }
      const framework = detectFramework(path, content);
      const boundary = extractRenderBoundary(path, content, framework);
      const stateDeps = extractStateDependencies(content, framework);
      const compName = basename(path, extname(path));
      const contract = await extractComponentContract(path, content);
      const aliasConfig = await loadAliasConfig(path);
      const allImports = extractLocalImports(content, aliasConfig, path);
      const { providers, consumers } = extractComponentContextNodes(path, content);

      const edges: Array<{ targetPath: string; isDynamic: boolean; payload?: EdgePayload }> = [];
      for (const imp of allImports) {
        let matchedPath = resolveImportPath(path, imp.source, aliasConfig);
        if (matchedPath && /[/\\]index\.[tj]sx?$/.test(matchedPath)) {
          matchedPath = resolveBarrelExport(matchedPath, imp.name, aliasConfig) ?? matchedPath;
        }
        if (matchedPath) matchedPath = canonicalizePath(matchedPath);

        if (matchedPath) {
          const candidateNames = getCandidateNames(imp.alias || imp.name || basename(matchedPath, extname(matchedPath)));
          const passedProps = extractPassedProps(content, candidateNames);

          edges.push({
            targetPath: matchedPath,
            isDynamic: imp.isDynamic ?? false,
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

      parsedFiles.set(path, {
        path,
        framework,
        boundary,
        stateDeps,
        compName,
        contract,
        edges,
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

/**
 * Synchronizes the workspace disk state with SQLite using staged sync.
 */
export async function syncWorkspace(
  workspaceRoot: string,
  scopePath?: string,
  database?: Database
): Promise<SyncStats> {
  const absRoot = canonicalizePath(workspaceRoot);
  const db = database ?? getWorkspaceDatabase(absRoot);
  const previous = syncQueues.get(db) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const { stagedSync } = await import('./staged-sync');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await stagedSync(absRoot, scopePath, db); }
      catch (err) {
        if (attempt || !(err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED'))) throw err;
      }
    }
    throw new Error('WORKSPACE_CHANGED: retries exhausted');
  });
  syncQueues.set(db, operation);
  try { return await operation; }
  finally { if (syncQueues.get(db) === operation) syncQueues.delete(db); }
}

const syncQueues = new WeakMap<Database, Promise<unknown>>();
