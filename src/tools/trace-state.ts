import fs from 'node:fs';
import {
  queryStateImpact,
  formatStateImpactAsText,
  traceStateChain,
  formatStateChainAsText,
} from '../engine/database';
import { resolveProjectRoot, resolveWorkspacePath } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const traceStateTool: McpToolDefinition = {
  name: 'trace_state',
  description:
    'Traces state store (Pinia/Zustand/Redux), Context, or composable impact across frontend components. Identifies where state is modified, read, or called. Supports shallow impact (depth: 1) as well as multi-hop cascading dependency chains (depth: 2+).',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'State identifier to trace (alias: state, store, composable, name, e.g. "useCartStore", "useRouter")',
      },
      state: {
        type: 'string',
        description: 'Alias for identifier',
      },
      store: {
        type: 'string',
        description: 'Alias for identifier',
      },
      composable: {
        type: 'string',
        description: 'Alias for identifier',
      },
      target_path: {
        type: 'string',
        description: 'Project root directory or file path (alias: path, file_path, filePath, default: ".")',
      },
      path: {
        type: 'string',
        description: 'Alias for target_path',
      },
      file_path: {
        type: 'string',
        description: 'Alias for path',
      },
      filePath: {
        type: 'string',
        description: 'Alias for path',
      },
      depth: {
        type: 'number',
        description: 'Traversal depth: 1 for direct consumers impact, or >1 for multi-hop call chain (default: 1)',
      },
      role: {
        type: 'string',
        enum: ['all', 'mutators', 'readers'],
        description:
          'Consumer role filter: "all" (grouped into mutators and readers), "mutators" (only triggers/action callers), or "readers" (only state/render consumers). Default: "all"',
      },
      direction: {
        type: 'string',
        enum: ['consumers', 'dependencies', 'both'],
        description: 'Direction for multi-hop tracing (default: "both")',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text")',
      },
    },
  },
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

    const targetPath = resolveProjectRoot(rawTargetPath);
    const depth = args.depth ? Number(args.depth) : 1;
    const isJson = args.output_format === 'json';

    if (depth > 1 || args.direction === 'dependencies') {
      const result = await traceStateChain(targetPath, {
        identifier,
        direction: args.direction as any,
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
  },
};
