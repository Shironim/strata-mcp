import { TOOL_CATALOG } from './catalog';
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
  ...TOOL_CATALOG[4],
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
      const routeView = args.view === 'full' || args.view === 'tree' ? args.view : 'summary';

      if (target === 'routes') {
        const manifest = await scanRoutes({
          targetPath,
          frameworkHint,
          prefix: args.prefix ? String(args.prefix) : undefined,
          view: routeView,
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
          view: args.view ? routeView : undefined,
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
