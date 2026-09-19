import { extractWorkspaceApiContracts, formatApiContractsAsText } from '../engine/api-contract';
import { resolveWorkspacePath } from '../engine/path-resolver';
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
        description: 'Workspace root or directory to scan for API call sites (default: active workspace).',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const rawPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    const targetPath = resolveWorkspacePath(rawPath);

    try {
      const result = await extractWorkspaceApiContracts({ targetPath });
      return {
        content: [
          {
            type: 'text',
            text: formatApiContractsAsText(result),
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
