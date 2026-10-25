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
import { checkRuntimeVersion, getCachedRuntimeVersion } from '../utils/version-check';

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

      const runtimeVersion = getCachedRuntimeVersion();
      void checkRuntimeVersion().catch(() => {});
      const formatAuditResponse = (payload: any, formattedText: string) => {
        const finalJson = isJson
          ? JSON.stringify({ runtime_version: runtimeVersion, ...(typeof payload === 'object' && payload !== null ? payload : { data: payload }) }, null, 2)
          : undefined;
        let finalText = isJson ? finalJson! : formattedText;
        if (!isJson && runtimeVersion.update_available) {
          finalText = `[Notice: Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Run: ${runtimeVersion.upgrade_command}]\n\n` + finalText;
        }
        return {
          content: [{ type: 'text' as const, text: finalText }],
          metadata: { runtime_version: runtimeVersion },
          runtime_version: runtimeVersion,
        };
      };

      if (target === 'routes') {
        const manifest = await scanRoutes({
          targetPath,
          scopePath,
          excludeDirs,
          frameworkHint,
          prefix: args.prefix ? String(args.prefix) : undefined,
          view: routeView,
        });
        return formatAuditResponse(manifest, formatRoutesAsText(manifest));
      }

      if (target === 'dead-components') {
        const result = await findUnusedComponents({
          targetPath,
          scopePath,
          ignorePatterns,
          excludePages: !includePages,
          excludeDirs,
        });
        return formatAuditResponse(result, formatUnusedAsText(result));
      }

      if (target === 'dead-state') {
        const result = await findUnusedState(targetPath, { scopePath, excludeDirs });
        return formatAuditResponse(result, formatUnusedStateAsText(result));
      }

      if (target === 'similar-templates') {
        const result = await findSimilarTemplates({
          targetPath,
          scopePath,
          threshold,
          excludeDirs,
        });
        return formatAuditResponse(result, formatSimilarTemplatesAsText(result));
      }

      if (target === 'design-tokens') {
        const result = await auditDesignTokens({
          targetPath,
          scopePath,
          excludeDirs,
        });
        return formatAuditResponse(result, formatDesignAuditAsText(result));
      }

      if (target === 'bundle-health') {
        const result = await auditBundleHealth({ targetPath, scopePath, excludeDirs });
        return formatAuditResponse(result, formatBundleAuditAsText(result));
      }

      if (target === 'api-contracts') {
        const result = await extractWorkspaceApiContracts({ targetPath, scopePath, excludeDirs });
        return formatAuditResponse(result, formatApiContractsAsText(result));
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

        return formatAuditResponse(result, formatArchetypeAuditAsText(result));
      }

      // target === 'all'
      const [routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts] = await Promise.all([
        scanRoutes({
          targetPath,
          scopePath,
          excludeDirs,
          frameworkHint,
          prefix: args.prefix ? String(args.prefix) : undefined,
          view: args.view ? routeView : undefined,
        }),
        findUnusedComponents({
          targetPath,
          scopePath,
          ignorePatterns,
          excludePages: !includePages,
          excludeDirs,
        }),
        findUnusedState(targetPath, { scopePath, excludeDirs }),
        findSimilarTemplates({
          targetPath,
          scopePath,
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

      return formatAuditResponse(
        { routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts },
        report
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to execute frontend audit: ${msg}` }],
      };
    }
  },
};
