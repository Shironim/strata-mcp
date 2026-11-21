import { toolMetadata } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { indexedRetrievalEvidence } from '../engine/index-retrieval-evidence';
import { formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { prepareIndexedAnalysis, isWorkspaceIndexed } from '../engine/prepare-index';
import { buildNotIndexedResponse } from './not-indexed-response';
import fs from 'node:fs';
import {
  queryStateImpact,
  formatStateImpactAsText,
  queryFileStateDeps,
  formatFileStateDepsAsText,
  traceStateChain,
  formatStateChainAsText,
} from '../engine/database';
import {
  findProjectRoot,
  parseSafePositiveInt,
  resolveProjectRoot,
  resolveWorkspacePath,
} from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

const traceStateToolDefinition: McpToolDefinition = {
  ...toolMetadata('trace_state'),
  handler: async (args: Record<string, any>) => {
    let identifier = (args.identifier || args.state || args.state_name || args.store || args.store_name || args.composable || args.name || args.symbol)
      ? String(args.identifier || args.state || args.state_name || args.store || args.store_name || args.composable || args.name || args.symbol).trim()
      : '';

    const rawTargetPath = (args.file_path || args.filePath || args.path || args.target_path)
      ? String(args.file_path || args.filePath || args.path || args.target_path)
      : undefined;

    // If identifier is missing but a file path was supplied, attempt to auto-detect store/composable identifiers
    let fileTargetForStateLookup: string | undefined;
    if (!identifier && rawTargetPath) {
      try {
        const rootHint = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
        const fullPath = resolveWorkspacePath(rawTargetPath, rootHint);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          fileTargetForStateLookup = fullPath;
          const content = fs.readFileSync(fullPath, 'utf8');
          const storeMatches = [...content.matchAll(/defineStore\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
          const composableMatches = [...content.matchAll(/export\s+(?:const|function)\s+(use[A-Za-z0-9_]+)/g)].map((m) => m[1]);
          const candidates = [...new Set([...storeMatches, ...composableMatches])];
          if (candidates.length === 1) {
            identifier = candidates[0];
          } else if (candidates.length > 1) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Missing required argument: 'identifier'. Multiple potential state identifiers detected in '${rawTargetPath}': [${candidates.join(', ')}]. Please rerun trace_state with identifier set to one of these.`,
                },
              ],
            };
          }
        }
      } catch (_) {}
    }

    if (!identifier && !fileTargetForStateLookup) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: "Missing required argument: 'identifier'. Please provide the store/state or composable name (e.g. 'useCartStore', 'useAuth').",
          },
        ],
      };
    }

    try {
      const rootHint = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
      let targetPath: string;
      if (rawTargetPath) {
        const resolved = resolveWorkspacePath(rawTargetPath, rootHint);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          targetPath = rootHint ? resolveProjectRoot(rootHint) : (findProjectRoot(resolved) || resolveProjectRoot(rawTargetPath));
        } else {
          targetPath = resolveProjectRoot(rawTargetPath);
        }
      } else {
        targetPath = resolveProjectRoot(rootHint);
      }

      const isJson = args.output_format === 'json' || args.format === 'json';
      const role = (args.role as 'all' | 'mutators' | 'readers') || 'all';

      if (!isWorkspaceIndexed(targetPath)) {
        return buildNotIndexedResponse(targetPath, isJson);
      }

      const depth = parseSafePositiveInt(args.depth ?? args.max_depth ?? args.maxDepth, 1) ?? 1;

      const shouldMultiHop = depth > 1 || args.direction === 'dependencies' || args.direction === 'both';
      const before = await prepareIndexedAnalysis(targetPath);
      if (!identifier && fileTargetForStateLookup) {
        const fileResult = await queryFileStateDeps(targetPath, fileTargetForStateLookup, role, { skipSync: true });
        const retrieval = indexedRetrievalEvidence({
          workspace: targetPath,
          scope: fileTargetForStateLookup,
          policy: 'state-trace-v1',
          before,
          query: { filePath: fileTargetForStateLookup, role },
          selectionReason: 'Indexed state dependencies selected by file path and role.',
        });
        return {
          structuredContent: { ...fileResult, retrieval },
          content: [
            {
              type: 'text',
              text: isJson
                ? JSON.stringify({ ...fileResult, retrieval }, null, 2)
                : `${formatFileStateDepsAsText(fileResult)}\n\n${formatRetrievalEvidence(retrieval)}`,
            },
          ],
        };
      }
      const evidence = () => indexedRetrievalEvidence({ workspace: targetPath, scope: targetPath, policy: 'state-trace-v1', before,
        query: { identifier, role, depth, direction: shouldMultiHop ? args.direction || 'both' : 'consumers' },
        selectionReason: 'State consumers/dependencies selected by identifier, role and bounded traversal.' });
      if (shouldMultiHop) {
        const result = await traceStateChain(targetPath, {
          identifier,
          direction: (args.direction as 'consumers' | 'dependencies' | 'both') || 'both',
          maxDepth: depth,
          role,
          skipSync: true,
        });
        const retrieval = evidence();
        return {
          structuredContent: { ...result, retrieval },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatStateChainAsText(result)}\n\n${formatRetrievalEvidence(retrieval)}`,
            },
          ],
        };
      }

      const result = await queryStateImpact(targetPath, identifier, role, { skipSync: true });
      const retrieval = evidence();
      return {
        structuredContent: { ...result, retrieval },
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatStateImpactAsText(result)}\n\n${formatRetrievalEvidence(retrieval)}`,
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to trace state "${identifier}": ${msg}` }],
      };
    }
  },
};

export const traceStateTool: McpToolDefinition = withRetrievalEvidence(traceStateToolDefinition, {
  formatText: (data) => {
    if (Array.isArray(data.dependencies) && typeof data.filePath === 'string') {
      return formatFileStateDepsAsText(data as any);
    }
    if (Array.isArray(data.dependencies)) {
      return formatStateChainAsText(data as any);
    }
    if (Array.isArray(data.consumers)) {
      const mutators = data.consumers.filter((c: any) => c.role === 'mutator');
      const readers = data.consumers.filter((c: any) => c.role !== 'mutator');
      return formatStateImpactAsText({
        ...data,
        mutators,
        readers,
        mutatorsCount: mutators.length,
        readersCount: readers.length,
      } as any);
    }
    return undefined;
  },
});
