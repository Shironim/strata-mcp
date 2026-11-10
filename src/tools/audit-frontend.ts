import { TOOL_CATALOG } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { observeRetrievalIndex, indexedRetrievalEvidence } from '../engine/index-retrieval-evidence';
import { formatRetrievalEvidence, filesystemAuditRetrievalEvidence } from '../engine/retrieval-evidence';
import { syncWorkspace } from '../engine/storage/delta-sync';
import { scanRoutes, formatRoutesAsText } from '../engine/routes';
import { findUnusedComponents, formatUnusedAsText } from '../engine/audit';
import { findUnusedState, formatUnusedStateAsText } from '../engine/database';
import {
  extractWorkspaceApiContracts,
  formatApiContractsAsText,
} from '../engine/api-contract';
import {
  normalizeAuditTarget,
  parseStringList,
  resolveProjectRoot,
  VALID_AUDIT_TARGETS,
} from '../engine/path-resolver';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';

const auditFrontendToolDefinition: McpToolDefinition = {
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
      const routeView = args.view === 'full' || args.view === 'tree' ? args.view : 'summary';

      const isDirectFilesystemTarget = ['routes', 'api-contracts'].includes(target);
      if (!isDirectFilesystemTarget) {
        try {
          await syncWorkspace(targetPath);
        } catch {}
      }
      const before = isDirectFilesystemTarget ? null : observeRetrievalIndex(targetPath);
      const formatAuditResponse = (payload: any, formattedText: string) => {
        const query = { target, excludeDirs, ignorePatterns, includePages, frameworkHint: frameworkHint ?? null, routeView, prefix: args.prefix ?? null };
        const retrieval = isDirectFilesystemTarget
          ? filesystemAuditRetrievalEvidence({
              workspace: targetPath,
              scope: scopePath ?? targetPath,
              policy: 'filesystem-audit-v1',
              query,
              selectionReason: 'Requested direct filesystem/AST audit target and filters; AST diagnostics retain their own evidence strength.',
            })
          : indexedRetrievalEvidence({
              workspace: targetPath,
              scope: scopePath ?? targetPath,
              policy: 'frontend-audit-v1',
              before,
              query,
              selectionReason: 'Requested audit target and filters; individual diagnostics retain their own evidence strength.',
            });
        const routeEntries = Array.isArray(payload?.routes) ? payload.routes : payload?.routes?.routes ?? [];
        const ownership = payload?.projectContext ?? payload?.routes?.projectContext;
        retrieval.omissions.push(...(ownership?.diagnostics ?? []));
        const configReasons = new Set<string>();
        for (const route of routeEntries) {
          const effective = route.nextEffectiveSegmentConfig;
          if (!effective) continue;
          for (const issue of effective.unresolvedFields) configReasons.add(`${issue.field}: ${issue.reason}`);
          if (effective.freshness === 'stale') configReasons.add(`${route.filePath}: Segment config sources changed or could not be read.`);
        }
        for (const reason of configReasons) retrieval.omissions.push({ code: 'NEXT_EFFECTIVE_CONFIG_PARTIAL', reason });
        const finalJson = isJson
          ? JSON.stringify({ ...(typeof payload === 'object' && payload !== null ? payload : { data: payload }), retrieval }, null, 2)
          : undefined;
        let finalText = isJson ? finalJson! : `${formattedText}\n\n${formatRetrievalEvidence(retrieval)}`;
        return {
          structuredContent: { ...(typeof payload === 'object' && payload !== null ? payload : { data: payload }), retrieval },
          content: [{ type: 'text' as const, text: finalText }],
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

      if (target === 'api-contracts') {
        const result = await extractWorkspaceApiContracts({ targetPath, scopePath, excludeDirs });
        return formatAuditResponse(result, formatApiContractsAsText(result));
      }

      // target === 'all': route/API topology and unused component/state candidates.
      const [routes, unusedComponents, unusedState, apiContracts] = await Promise.all([
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
        formatApiContractsAsText(apiContracts),
      ].join('\n');

      return formatAuditResponse(
        { routes, unusedComponents, unusedState, apiContracts },
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

export const auditFrontendTool: McpToolDefinition = withRetrievalEvidence(auditFrontendToolDefinition, {
  formatText: (data, page) => {
    if (page.path === 'routes' && Array.isArray(data.routes)) {
      return formatRoutesAsText(data as any);
    }
    if (page.path === 'unusedComponents' && Array.isArray(data.unusedComponents)) {
      return formatUnusedAsText(data as any);
    }
    if (page.path === 'unusedState' && Array.isArray(data.unusedState)) {
      return formatUnusedStateAsText(data as any);
    }
    if (page.path === 'endpoints' && Array.isArray(data.endpoints)) {
      return formatApiContractsAsText(data as any);
    }
    return undefined;
  },
});
