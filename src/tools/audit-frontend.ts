import { scanRoutes, formatRoutesAsText } from '../engine/routes';
import { findUnusedComponents, formatUnusedAsText } from '../engine/audit';
import { findUnusedState, formatUnusedStateAsText } from '../engine/database';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';

export const auditFrontendTool: McpToolDefinition = {
  name: 'audit_frontend',
  description:
    'Performs a comprehensive architectural audit of the frontend codebase: maps all file-based URL routes, detects orphan/dead components, and discovers unused state stores/composables. Can audit specific targets or run a full health check (target: "all").',
  inputSchema: {
    type: 'object',
    properties: {
      target_path: {
        type: 'string',
        description: 'Project root directory (alias: path, default: ".")',
      },
      path: {
        type: 'string',
        description: 'Alias for target_path',
      },
      target: {
        type: 'string',
        enum: ['routes', 'dead-components', 'dead-state', 'all'],
        description:
          'Audit target: "routes" (URL topology), "dead-components" (orphan components), "dead-state" (unused composables/stores), or "all" for a full architectural diagnostic (default: "all")',
      },
      prefix: {
        type: 'string',
        description: 'Optional URL prefix filter for route scanner (e.g. "/api", "/auth")',
      },
      framework: {
        type: 'string',
        enum: ['next-app', 'next-pages', 'nuxt', 'astro', 'inertia', 'unknown'],
        description: 'Optional framework hint for route scanner',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to exclude from dead component audit',
      },
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names or paths to ignore during traversal',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text")',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    const targetPath = (args.target_path || args.path)
      ? String(args.target_path || args.path)
      : process.cwd();
    const target = args.target ? String(args.target) : 'all';
    const isJson = args.output_format === 'json';
    const excludeDirs = Array.isArray(args.exclude_dirs)
      ? args.exclude_dirs.map(String)
      : typeof args.exclude_dirs === 'string'
        ? (args.exclude_dirs as string).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    if (target === 'routes') {
      const manifest = await scanRoutes({
        targetPath,
        frameworkHint: args.framework as RouteFramework | undefined,
        prefix: args.prefix ? String(args.prefix) : undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(manifest, null, 2) : formatRoutesAsText(manifest),
          },
        ],
      };
    }

    if (target === 'dead-components') {
      const result = await findUnusedComponents({
        targetPath,
        ignorePatterns: args.ignore_patterns as string[] | undefined,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatUnusedAsText(result),
          },
        ],
      };
    }

    if (target === 'dead-state') {
      const result = await findUnusedState(targetPath);
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatUnusedStateAsText(result),
          },
        ],
      };
    }

    // target === 'all'
    const [routes, unusedComponents, unusedState] = await Promise.all([
      scanRoutes({
        targetPath,
        frameworkHint: args.framework as RouteFramework | undefined,
        prefix: args.prefix ? String(args.prefix) : undefined,
      }),
      findUnusedComponents({
        targetPath,
        ignorePatterns: args.ignore_patterns as string[] | undefined,
        excludeDirs,
      }),
      findUnusedState(targetPath),
    ]);

    if (isJson) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ routes, unusedComponents, unusedState }, null, 2),
          },
        ],
      };
    }

    const report = [
      '## Frontend Architecture & Health Audit',
      `Target: \`${targetPath}\`\n`,
      formatRoutesAsText(routes),
      '\n---\n',
      formatUnusedAsText(unusedComponents),
      '\n---\n',
      formatUnusedStateAsText(unusedState),
    ].join('\n');

    return {
      content: [{ type: 'text', text: report }],
    };
  },
};
