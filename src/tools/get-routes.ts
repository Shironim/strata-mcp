import { scanRoutes, formatRoutesAsText } from '../engine/routes';
import { resolveWorkspacePath } from '../engine/path-resolver';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';

export const getRoutesTool: McpToolDefinition = {
  name: 'get_routes',
  description:
    'Discovers and maps frontend routes across Next.js (App & Pages router), Nuxt (pages/), Astro (src/pages), and Laravel Inertia. Returns route paths, params, layout hierarchy, and page components without full file reading.',
  inputSchema: {
    type: 'object',
    properties: {
      targetPath: {
        type: 'string',
        description: 'Workspace root or frontend directory to scan for routes (default: active workspace).',
      },
      framework: {
        type: 'string',
        enum: ['next-app', 'nuxt', 'astro', 'inertia'],
        description: 'Optional framework hint to optimize route discovery.',
      },
      prefix: {
        type: 'string',
        description: 'Filter routes by URL path prefix (e.g. "/dashboard", "/api", "/auth").',
      },
      view: {
        type: 'string',
        enum: ['summary', 'full', 'tree'],
        description: 'Output format style (default: "summary" for high-level token efficiency).',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const rawPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    const targetPath = resolveWorkspacePath(rawPath);
    const framework = args.framework as RouteFramework | undefined;
    const prefix = typeof args.prefix === 'string' ? args.prefix : undefined;
    const view = args.view === 'full' || args.view === 'tree' ? args.view : 'summary';

    try {
      const manifest = await scanRoutes({
        targetPath,
        frameworkHint: framework,
        urlPrefix: prefix,
        viewMode: view,
      });

      return {
        content: [
          {
            type: 'text',
            text: formatRoutesAsText(manifest),
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
            text: `Failed to scan frontend routes: ${msg}`,
          },
        ],
      };
    }
  },
};
