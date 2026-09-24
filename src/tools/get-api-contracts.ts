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
      targetPath: {
        type: 'string',
        description: 'Workspace root or directory to scan for API call sites (alias: target_path, path).',
      },
      target_path: {
        type: 'string',
        description: 'Alias for targetPath',
      },
      path: {
        type: 'string',
        description: 'Alias for targetPath',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text")',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const targetPath = resolveToolTargetPath(args);
    const isJson = args.output_format === 'json';

    try {
      const result = await extractWorkspaceApiContracts({ targetPath });
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
