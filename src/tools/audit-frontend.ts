import { scanRoutes, formatRoutesAsText } from '../engine/routes';
import { findUnusedComponents, formatUnusedAsText } from '../engine/audit';
import { findUnusedState, formatUnusedStateAsText } from '../engine/database';
import {
  findSimilarTemplates,
  formatSimilarTemplatesAsText,
} from '../engine/template-similarity';
import { auditDesignTokens, formatDesignAuditAsText } from '../engine/style-audit';
import { auditBundleHealth, formatBundleAuditAsText } from '../engine/bundle-audit';
import { resolveProjectRoot } from '../engine/path-resolver';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';

export const auditFrontendTool: McpToolDefinition = {
  name: 'audit_frontend',
  description:
    'Architectural frontend health audit: file-based routes, dead components, unused state composables, structural template similarity, design tokens & a11y, and bundle health / island hydration. Supports targeted or full audits (target: "all").',
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
      scope_path: {
        type: 'string',
        description:
          'Sub-directory or workspace scope filter within target_path (e.g. "apps/web") to avoid scanning entire monorepos and prevent cold-start timeouts',
      },
      target: {
        type: 'string',
        enum: ['routes', 'dead-components', 'dead-state', 'similar-templates', 'design-tokens', 'bundle-health', 'all'],
        description:
          'Audit target: "routes" (URL topology), "dead-components" (orphan components), "dead-state" (unused composables/stores), "similar-templates" (redundant template structure & DRY opportunities), "design-tokens" (arbitrary Tailwind colors/spacing, radius consistency & a11y violations), "bundle-health" (heavy eager imports & eager island hydration), or "all" for a full architectural diagnostic (default: "all")',
      },
      threshold: {
        type: 'number',
        description: 'Similarity threshold for template redundancy audit between 0.0 and 1.0 (default: 0.8)',
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
    const rawTargetPath = (args.target_path || args.path)
      ? String(args.target_path || args.path)
      : undefined;
    const targetPath = resolveProjectRoot(rawTargetPath);
    const scopePath = args.scope_path ? String(args.scope_path) : undefined;
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
      const result = await findUnusedState(targetPath, { scopePath });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatUnusedStateAsText(result),
          },
        ],
      };
    }

    if (target === 'similar-templates') {
      const result = await findSimilarTemplates({
        targetPath,
        threshold: args.threshold ? Number(args.threshold) : undefined,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatSimilarTemplatesAsText(result),
          },
        ],
      };
    }

    if (target === 'design-tokens' || target === 'design') {
      const result = await auditDesignTokens({
        targetPath,
        scopePath,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatDesignAuditAsText(result),
          },
        ],
      };
    }

    if (target === 'bundle-health' || target === 'bundle') {
      const result = await auditBundleHealth({
        targetPath,
        scopePath,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatBundleAuditAsText(result),
          },
        ],
      };
    }

    // target === 'all'
    const [routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit] = await Promise.all([
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
      findUnusedState(targetPath, { scopePath }),
      findSimilarTemplates({
        targetPath,
        threshold: args.threshold ? Number(args.threshold) : undefined,
        excludeDirs,
      }),
      auditDesignTokens({
        targetPath,
        scopePath,
        excludeDirs,
      }),
      auditBundleHealth({
        targetPath,
        scopePath,
        excludeDirs,
      }),
    ]);

    if (isJson) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit }, null, 2),
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
      '\n---\n',
      formatSimilarTemplatesAsText(similarTemplates),
      '\n---\n',
      formatDesignAuditAsText(designSystemAudit),
      '\n---\n',
      formatBundleAuditAsText(bundleAudit),
    ].join('\n');

    return {
      content: [{ type: 'text', text: report }],
    };
  },
};
