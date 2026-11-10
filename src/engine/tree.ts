import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRouteEntry } from './routes';
import { getDownwardComponentTree } from './graph/downward-traversal';
import { getUpwardComponentTree } from './graph/upward-traversal';
import type { ComponentTreeOptions, ComponentTreeResult } from '../types';
/**
 * Tree Facade (Strata MCP Engine)
 *
 * Backward-compatible facade re-exporting graph traversal, component hierarchy building,
 * context analysis, props drilling detection, and path resolution from `src/engine/graph/`.
 */

export * from './graph/path-helpers';
export * from './graph/props-drilling';
export * from './graph/context-analyzer';
export * from './graph/downward-traversal';
export * from './graph/upward-traversal';


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

  const isUpward = options.direction === 'upward' || options.direction === 'up';
  const result = isUpward
    ? await getUpwardComponentTree(effectiveOptions)
    : await getDownwardComponentTree(effectiveOptions);

  if (resolvedRouteInfo) {
    result.resolvedRoute = resolvedRouteInfo;
  }

  return result;
}
