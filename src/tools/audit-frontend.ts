import { toolMetadata } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { indexedRetrievalEvidence } from '../engine/index-retrieval-evidence';
import { formatRetrievalEvidence, filesystemAuditRetrievalEvidence } from '../engine/retrieval-evidence';
import { formatRoutesAsText } from '../engine/routes';
import { formatUnusedAsText } from '../engine/audit';
import { formatUnusedStateAsText } from '../engine/database';
import { formatApiContractsAsText } from '../engine/api-contract';
import { normalizeAuditTarget, parseStringList, resolveProjectRoot, VALID_AUDIT_TARGETS } from '../engine/path-resolver';
import type { RouteFramework } from '../types';
import type { McpToolDefinition } from './types';
import { analyzeFrontend, formatFrontendAudit, type AuditTarget } from '../engine/frontend-audit';

const auditFrontendToolDefinition: McpToolDefinition = {
  ...toolMetadata('audit_frontend'),
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

      const analysis = await analyzeFrontend({ target: target as AuditTarget, targetPath, scopePath, excludeDirs,
        ignorePatterns, includePages, frameworkHint, view: args.view ? routeView : undefined,
        prefix: args.prefix ? String(args.prefix) : undefined });
      const before = analysis.before;
      const isDirectFilesystemTarget = before === null;
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

      return formatAuditResponse(analysis.data, formatFrontendAudit(analysis, targetPath));
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
