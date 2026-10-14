import { TOOL_CATALOG } from './catalog';
import fs from 'node:fs';
import {
  queryStateImpact,
  formatStateImpactAsText,
  traceStateChain,
  formatStateChainAsText,
} from '../engine/database';
import {
  parseSafePositiveInt,
  resolveProjectRoot,
  resolveWorkspacePath,
} from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const traceStateTool: McpToolDefinition = {
  ...TOOL_CATALOG[3],
  handler: async (args: Record<string, any>) => {
    let identifier = (args.identifier || args.state || args.state_name || args.store || args.store_name || args.composable || args.name || args.symbol)
      ? String(args.identifier || args.state || args.state_name || args.store || args.store_name || args.composable || args.name || args.symbol).trim()
      : '';

    const rawTargetPath = (args.target_path || args.path || args.file_path || args.filePath)
      ? String(args.target_path || args.path || args.file_path || args.filePath)
      : undefined;

    // If identifier is missing but a file path was supplied, attempt to auto-detect store/composable identifiers
    if (!identifier && rawTargetPath) {
      try {
        const fullPath = resolveWorkspacePath(rawTargetPath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
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

    if (!identifier) {
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
      const targetPath = resolveProjectRoot(rawTargetPath);
      const isJson = args.output_format === 'json' || args.format === 'json';

      const { isWorkspaceIndexed } = await import('../engine/storage/schema');
      if (!isWorkspaceIndexed(targetPath)) {
        const notIndexedPayload = {
          status: 'NOT_INDEXED',
          message: "Workspace belum diindeks oleh Strata. Jalankan 'strata init' terlebih dahulu di terminal atau panggil tool inisialisasi yang disetujui.",
        };
        return {
          content: [
            {
              type: 'text',
              text: isJson
                ? JSON.stringify(notIndexedPayload, null, 2)
                : `[strata] ${notIndexedPayload.message}`,
            },
          ],
        };
      }

      const depth = parseSafePositiveInt(args.depth ?? args.max_depth ?? args.maxDepth, 1) ?? 1;

      const shouldMultiHop = depth > 1 || args.direction === 'dependencies' || args.direction === 'both';
      if (shouldMultiHop) {
        const result = await traceStateChain(targetPath, {
          identifier,
          direction: (args.direction as 'consumers' | 'dependencies' | 'both') || 'both',
          maxDepth: depth,
        });
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatStateChainAsText(result),
            },
          ],
        };
      }

      const role = (args.role as 'all' | 'mutators' | 'readers') || 'all';
      const result = await queryStateImpact(targetPath, identifier, role);
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatStateImpactAsText(result),
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
