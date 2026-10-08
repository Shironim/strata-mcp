import { extractWorkspaceApiContracts, formatApiContractsAsText } from '../engine/api-contract';
import { resolveToolTargetPath } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const getApiContractsTool: McpToolDefinition = {
  name: 'get_api_contracts',
  description:
    'Scans frontend components (.vue, .tsx, .jsx, .astro) for outbound API network boundaries (Inertia visit/post/put, TanStack useQuery/useMutation, Axios, fetch, useFetch). Extracts endpoint URLs, HTTP methods, and payload field keys without reading full files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace root or directory to scan for API call sites (alias: target_path, targetPath).',
      },
      target_path: {
        type: 'string',
        description: 'Alias for path',
      },
      targetPath: {
        type: 'string',
        description: 'Alias for path',
      },
      scope_path: {
        type: 'string',
        description: 'Sub-directory or workspace scope filter within path (e.g. "apps/web") to avoid scanning entire monorepos',
      },
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names or paths to ignore during traversal',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Alias for format',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const targetPath = resolveToolTargetPath(args);
    const scopePath = args.scope_path ? String(args.scope_path) : undefined;
    const excludeDirs = Array.isArray(args.exclude_dirs)
      ? args.exclude_dirs.map(String)
      : typeof args.exclude_dirs === 'string'
        ? (args.exclude_dirs as string).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
    const isJson = args.output_format === 'json' || args.format === 'json';

    try {
      const result = await extractWorkspaceApiContracts({ targetPath, scopePath, excludeDirs });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatApiContractsAsText(result),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Failed to extract API contracts: ${msg}`,
          },
        ],
      };
    }
  },
};
