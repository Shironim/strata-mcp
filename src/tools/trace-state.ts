import {
  queryStateImpact,
  formatStateImpactAsText,
  traceStateChain,
  formatStateChainAsText,
} from '../engine/database';
import { resolveProjectRoot } from '../engine/path-resolver';
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
        description: 'State identifier to trace (e.g. "useCartStore", "useRouter", "usePenjualanForm")',
      },
      target_path: {
        type: 'string',
        description: 'Project root directory (alias: path, default: ".")',
      },
      path: {
        type: 'string',
        description: 'Alias for target_path',
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
    required: ['identifier'],
  },
  handler: async (args: Record<string, any>) => {
    const identifier = args.identifier ? String(args.identifier).trim() : '';
    if (!identifier) {
      return {
        isError: true,
        content: [{ type: 'text', text: "Missing required argument: 'identifier'" }],
      };
    }

    const rawTargetPath = (args.target_path || args.path)
      ? String(args.target_path || args.path)
      : undefined;
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
