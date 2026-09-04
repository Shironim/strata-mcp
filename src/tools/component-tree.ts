import { getComponentTree, formatTreeAsText } from '../engine/tree';
import type { McpToolDefinition } from './types';

export const componentTreeTool: McpToolDefinition = {
  name: 'get_component_tree',
  description:
    'Resolves component hierarchy and call graph trees starting from a root file, layout, or directly from a URL route path (e.g. "/dashboard"). Supports downward traversal (root -> children) to see the sub-tree, or upward traversal (leaf -> consumers/pages) to inspect upstream blast radius.',
  inputSchema: {
    type: 'object',
    properties: {
      entry_path: {
        type: 'string',
        description: 'Path to the root component/page file (or use route)',
      },
      route: {
        type: 'string',
        description: 'URL route path to resolve directly to page entrypoint and tree (e.g. "/dashboard", "/catalog/[id]")',
      },
      route_path: {
        type: 'string',
        description: 'Alias for route',
      },
      target_path: {
        type: 'string',
        description: 'Project root or pages directory (default: ".")',
      },
      path: {
        type: 'string',
        description: 'Alias for target_path',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 3)',
      },
      direction: {
        type: 'string',
        enum: ['downward', 'upward'],
        description:
          'Traversal direction: "downward" (root -> children) or "upward" (leaf -> consumers/pages blast radius). Default: "downward".',
      },
      alias_map: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Optional alias map overriding auto-detected jsconfig/tsconfig paths (e.g. { "@/": "resources/js/" })',
      },
      scope_filter: {
        type: 'string',
        description: 'Optional package/domain scope filter (e.g. "apps/web", "features/auth")',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text (indented tree) or json (default: "text")',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    const routePath = (args.route || args.route_path) ? String(args.route || args.route_path) : undefined;
    const entryPath = args.entry_path ? String(args.entry_path) : undefined;
    const targetPath = (args.target_path || args.path) ? String(args.target_path || args.path) : undefined;

    if (!entryPath && !routePath) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: "Missing required argument: provide 'entry_path' (file path) or 'route' (URL route path).",
          },
        ],
      };
    }

    const tree = await getComponentTree({
      entryPath,
      routePath,
      targetPath,
      maxDepth: args.max_depth ? Number(args.max_depth) : undefined,
      direction: args.direction as any,
      aliasMap: args.alias_map as Record<string, string> | undefined,
      scopeFilter: args.scope_filter ? String(args.scope_filter) : undefined,
    });

    const isJson = args.output_format === 'json';
    return {
      content: [
        {
          type: 'text',
          text: isJson ? JSON.stringify(tree, null, 2) : formatTreeAsText(tree),
        },
      ],
    };
  },
};
