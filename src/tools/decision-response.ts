import type { RetrievalEvidence } from '../types';
import type { ToolCallResponse } from './types';
import { assessCapability } from './capabilities';
import { describeResultSelection } from './result-selection';
import { renderBoundaryOmission } from './boundary-evidence';
import type { RenderBoundaryInfo } from '../types';

/** Decision metadata describes the result, never upgrades the analyzer's evidence. */
export function withDecisionResponse(result: ToolCallResponse, tool: string, args: Record<string, any>) {
  const data = result.structuredContent ?? {};
  const evidence = data.retrieval as RetrievalEvidence | undefined;
  const message = result.content.map(block => block.text).join('\n');
  const codes = evidence?.omissions?.map(item => item.code) ?? [];
  const notChecked = codes.includes('NOT_INDEXED') || message.startsWith('[strata NOT_INDEXED]');
  const stale = evidence?.freshness === 'stale';
  const failed = result.isError === true;
  const selection = describeResultSelection(tool, args, data);
  const empty = selection.count === 0;
  const coverage = data.coverage as Record<string, unknown> | undefined;
  const summary = data.resultSummary as { contract?: { renderBoundary?: RenderBoundaryInfo } } | undefined;
  const boundaryGap = renderBoundaryOmission(data.renderBoundary as RenderBoundaryInfo | undefined ?? summary?.contract?.renderBoundary);
  const hasGaps = [data.diagnostics, coverage?.omissions, coverage?.diagnostics].some(value => Array.isArray(value) && value.length > 0)
    || Number(coverage?.failedCount ?? 0) > 0 || Number(coverage?.unsupportedCount ?? 0) > 0 || Boolean(boundaryGap);
  const complete = evidence?.completeness === 'complete' && evidence.freshness === 'current'
    && typeof evidence.scope === 'string' && evidence.scope.length > 0
    && Array.isArray(evidence.omissions) && evidence.omissions.length === 0
    && !data.truncated && !data.isTruncated && !data.is_truncated && !coverage?.truncated && !hasGaps;
  const status = stale ? 'stale' : failed || notChecked || !evidence?.freshness || !evidence.completeness ? 'unknown' : complete ? 'ok' : 'partial';
  const emptyOutcome = notChecked ? 'not-checked' : failed ? 'analysis-failed' : empty ? complete ? 'none-in-checked-scope' : 'inconclusive' : 'not-asserted';
  const snapshot = data.snapshot as { file?: string } | undefined;
  const path = data.file ?? snapshot?.file ?? args.path ?? args.file_path ?? args.component_path ?? args.filePath;
  const scopeArgs = args.project_root ? { project_root: args.project_root } : {};
  const firstRegion = (data.regions as Array<{ ref?: unknown }> | undefined)?.find(region => region.ref);
  const next = stale
    ? [{ action: 'retrieve-again', reason: 'Source or retrieval identity changed. Discard old refs and repeat the original request.' }]
    : notChecked
      ? [{ action: 'initialize-workspace', reason: 'Run strata init in the intended workspace, then repeat the request.' }]
      : failed
        ? [{ action: 'correct-request', reason: 'Correct the parameter or environment identified in the original error before retrying.' }]
        : data.resultSummary
          ? [{ action: 'request-detail', tool, arguments: { response_detail: 'full' }, argumentMode: 'merge-original', reason: 'Repeat the original request with response_detail full to retrieve the omitted primary analysis before editing.' }]
        : data.continuationToken
          ? [{ action: 'continue', tool, arguments: { continuation_token: data.continuationToken }, reason: 'Repeat the original request with this continuation_token to retrieve remaining results before concluding absence.' }]
          : tool === 'inspect_component' && args.view === 'map' && firstRegion
            ? [{ action: 'read-mapped-region', tool, arguments: { path, view: 'source', source_ref: firstRegion.ref, ...scopeArgs }, reason: 'Read this mapped region, or substitute the source_ref for the region relevant to your task.' }]
          : typeof path === 'string' && /\.(vue|tsx?|jsx?|astro|svelte)$/.test(path)
            ? [{ action: 'inspect-source', tool: 'inspect_component', arguments: { path, view: 'map' }, reason: 'Inspect source regions and diagnostics before editing; use a returned source_ref to retrieve exact source.' }]
            : [{ action: 'review-coverage', reason: 'Review scope, omissions and capability limits before concluding that no usage exists.' }];
  const decision = { status, emptyOutcome, selection, capability: assessCapability(tool, args, data), next };

  return { ...result, structuredContent: { ...data, decision } };
}
