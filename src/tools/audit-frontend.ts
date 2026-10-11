import { scanRoutes, formatRoutesAsText } from '../engine/routes';
import { findUnusedComponents, formatUnusedAsText } from '../engine/audit';
import { findUnusedState, formatUnusedStateAsText } from '../engine/database';
import {
  findSimilarTemplates,
  formatSimilarTemplatesAsText,
} from '../engine/template-similarity';
import { auditDesignTokens, formatDesignAuditAsText } from '../engine/style-audit';
import { auditBundleHealth, formatBundleAuditAsText } from '../engine/bundle-audit';
import {
  extractWorkspaceApiContracts,
  formatApiContractsAsText,
} from '../engine/api-contract';
import {
  auditPageArchetypeDrift,
  formatArchetypeAuditAsText,
} from '../engine/archetype';
import {
  normalizeAuditTarget,
  parseSafeFloat,
  parseStringList,
  resolveProjectRoot,
  resolveWorkspacePath,
  VALID_AUDIT_TARGETS,
} from '../engine/path-resolver';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';

export const auditFrontendTool: McpToolDefinition = {
  name: 'audit_frontend',
  description:
    'Architectural frontend health audit: file-based routes, dead components, unused state composables, structural template similarity, design tokens & a11y, bundle health / island hydration, and page archetype structural drift. Supports targeted or full audits (target: "all").',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project root directory or target page file for archetype-drift (alias: target_path, default: ".")',
      },
      target_path: {
        type: 'string',
        description: 'Alias for path',
      },
      exemplar_path: {
        type: 'string',
        description:
          'Optional exemplar/reference page file path for target: "archetype-drift" (auto-discovers richest sibling page when omitted)',
      },
      scope_path: {
        type: 'string',
        description:
          'Sub-directory or workspace scope filter within target_path (e.g. "apps/web") to avoid scanning entire monorepos and prevent cold-start timeouts',
      },
      target: {
        type: 'string',
        enum: [
          'routes',
          'dead-components',
          'dead-state',
          'similar-templates',
          'design-tokens',
          'bundle-health',
          'api-contracts',
          'archetype-drift',
          'all',
        ],
        description:
          'Audit target: "routes" (URL topology), "dead-components" (orphan components), "dead-state" (unused composables/stores), "similar-templates" (redundant template structure & DRY opportunities), "design-tokens" (arbitrary Tailwind colors/spacing, radius consistency & a11y violations), "bundle-health" (heavy eager imports & eager island hydration), "api-contracts" (outbound API endpoints & caller mapping), "archetype-drift" (page semantic section & component drift vs exemplar), or "all" for a full architectural diagnostic (default: "all")',
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
        enum: ['next-app', 'next-pages', 'nuxt', 'astro', 'inertia', 'vue-router', 'unknown'],
        description: 'Optional framework hint for route scanner',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to exclude from dead component audit',
      },
      include_pages: {
        type: 'boolean',
        description: 'Include page/view files in dead-components audit (default: false)',
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
    },
  },
  handler: async (args: Record<string, any>) => {
    try {
      const rawTargetPath = (args.target_path || args.path || args.targetPath)
        ? String(args.target_path || args.path || args.targetPath)
        : undefined;
      const targetPath = resolveProjectRoot(rawTargetPath);
      const rawScope = args.scope_path ?? args.scopePath ?? args.scope_filter ?? args.scopeFilter;
      const scopePath = rawScope ? String(rawScope) : undefined;

      const target = normalizeAuditTarget(args.target, 'all');
      if (!VALID_AUDIT_TARGETS.has(target)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Invalid audit target: "${args.target}". Supported targets: ${[...VALID_AUDIT_TARGETS].join(', ')}`,
            },
          ],
        };
      }

      const isJson = args.output_format === 'json' || args.format === 'json';
      const excludeDirs = parseStringList(args.exclude_dirs ?? args.excludeDirs);
      const ignorePatterns = parseStringList(args.ignore_patterns ?? args.ignorePatterns);
      const includePages = Boolean(args.include_pages ?? args.includePages);
      const frameworkHint = (args.framework || args.framework_hint || args.frameworkHint) as RouteFramework | undefined;
      const threshold = parseSafeFloat(args.threshold);

      if (target === 'routes') {
        const manifest = await scanRoutes({
          targetPath,
          frameworkHint,
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
          ignorePatterns,
          excludePages: !includePages,
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
          threshold,
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

      if (target === 'design-tokens') {
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

      if (target === 'bundle-health') {
        const result = await auditBundleHealth({ targetPath, scopePath, excludeDirs });
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatBundleAuditAsText(result),
            },
          ],
        };
      }

      if (target === 'api-contracts') {
        const result = await extractWorkspaceApiContracts({ targetPath, scopePath, excludeDirs });
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatApiContractsAsText(result),
            },
          ],
        };
      }

      if (target === 'archetype-drift') {
        if (!rawTargetPath) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: "Missing required argument: 'path' (or 'target_path') pointing to the target page file for archetype-drift audit.",
              },
            ],
          };
        }
        const resolvedPagePath = resolveWorkspacePath(rawTargetPath);
        const rawExemplar = args.exemplar_path || args.exemplar || args.exemplarPath;
        const resolvedExemplarPath = rawExemplar
          ? resolveWorkspacePath(String(rawExemplar), targetPath)
          : undefined;

        const result = await auditPageArchetypeDrift({
          targetPath: resolvedPagePath,
          exemplarPath: resolvedExemplarPath,
          workspaceRoot: targetPath,
        });

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatArchetypeAuditAsText(result),
            },
          ],
        };
      }

      // target === 'all'
      const [routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts] = await Promise.all([
        scanRoutes({
          targetPath,
          frameworkHint,
          prefix: args.prefix ? String(args.prefix) : undefined,
        }),
        findUnusedComponents({
          targetPath,
          ignorePatterns,
          excludePages: !includePages,
          excludeDirs,
        }),
        findUnusedState(targetPath, { scopePath }),
        findSimilarTemplates({
          targetPath,
          threshold,
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
        extractWorkspaceApiContracts({
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
              text: JSON.stringify({ routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts }, null, 2),
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
        '\n---\n',
        formatApiContractsAsText(apiContracts),
      ].join('\n');

      return {
        content: [{ type: 'text', text: report }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to execute frontend audit: ${msg}` }],
      };
    }
  },
};
