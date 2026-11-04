import { describeResultSelection } from './result-selection';
import type { ProjectOwnershipInfo, RenderBoundaryInfo, RetrievalEvidence } from '../types';
import type { ToolCallResponse } from './types';

/** Preserve known nested safety diagnostics even when their owning item is outside the preview. */
function collectSafetyDetails(data: Record<string, unknown>) {
  const details: Array<{ path: string; file?: unknown; value: unknown }> = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    const item = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(item)) {
      if (!path && ['retrieval', 'coverage', 'diagnostics', 'propImpact', 'verification', 'cost'].includes(key)) continue;
      const nextPath = path ? `${path}.${key}` : key;
      if (/warning|diagnostic|omission|violation|limitation|unresolvedFields|unresolvedTypes|reactivitySmells|propsDrilling/i.test(key)) {
        if (child !== undefined && child !== null && (!Array.isArray(child) || child.length))
          details.push({ path: nextPath, file: item.filePath ?? item.file, value: child });
      } else visit(child, nextPath);
    }
  };
  visit(data, '');
  return details;
}

/** Explicit summary projection; primary payload is requested again with response_detail: full. */
export function summarizeToolResponse(result: ToolCallResponse, tool: string, args: Record<string, any>): ToolCallResponse {
  if (args.response_detail !== 'summary' || result.isError) return result;
  const data = result.structuredContent ?? {};
  const selection = describeResultSelection(tool, args, data);
  const preview = selection.collections.flatMap(path => {
    const items = path.split('.').reduce<any>((value, key) => value?.[key], data);
    return Array.isArray(items) ? items.slice(0, 3).map((item: any) => {
      if (!item || typeof item !== 'object') return item;
      return Object.fromEntries(['file', 'filePath', 'path', 'name', 'component', 'line', 'column', 'resolution', 'relationKind', 'reason', 'ref', 'sourceRef']
        .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
    }) : [];
  });
  const retrieval = data.retrieval ? structuredClone(data.retrieval) as RetrievalEvidence : undefined;
  if (retrieval) {
    retrieval.completeness = 'partial';
    retrieval.omissions.push({ code: 'SUMMARY_DETAIL_OMITTED', reason: 'This is an explicit summary projection; request response_detail full before editing or asserting complete coverage.' });
  }
  const impact = data.propImpact as Record<string, any> | undefined;
  const boundary = data.renderBoundary as RenderBoundaryInfo | undefined;
  const context = (data.projectContext ?? (data.routes as { projectContext?: ProjectOwnershipInfo } | undefined)?.projectContext) as ProjectOwnershipInfo | undefined;
  const contextSummary = context ? {
    scopeRoot: context.scopeRoot, ownerRoot: context.ownerRoot, status: context.status,
    applicationFramework: context.applicationFramework, appRoot: context.appRoot, configFiles: context.configFiles,
  } : undefined;
  const boundarySummary = boundary ? {
    boundary: boundary.boundary, isClientHydrated: boundary.isClientHydrated,
    ...(boundary.directive !== undefined ? { directive: boundary.directive } : {}),
    ...(boundary.evidence ? { evidence: boundary.evidence } : {}),
  } : undefined;
  const structuredContent = {
    resultSummary: { version: 1, tool, selection, preview,
      ...(!Array.isArray(data.props) && contextSummary ? { projectContext: contextSummary } : {}),
      ...(Array.isArray(data.props) ? { contract: { propCount: data.props.length, props: data.props.slice(0, 10),
        ...(data.framework !== undefined ? { framework: data.framework } : {}),
        ...(boundarySummary ? { renderBoundary: boundarySummary } : {}),
        ...(contextSummary ? { projectContext: contextSummary } : {}),
        emitCount: Array.isArray(data.emits) ? data.emits.length : null, slotCount: Array.isArray(data.slots) ? data.slots.length : null } } : {}),
      detailRequest: { tool, arguments: { response_detail: 'full' }, argumentMode: 'merge-original' } },
    safetyDetails: collectSafetyDetails(data),
    isTruncated: true,
    ...(retrieval ? { retrieval } : {}),
    ...Object.fromEntries(['coverage', 'diagnostics', 'verification', 'interpretation', 'inputFreshness'].filter(key => data[key] !== undefined).map(key => [key, data[key]])),
    ...(impact ? { propImpact: { ...impact, props: impact.props.map(({ usages, omissions, ...prop }: Record<string, unknown>) => prop) } } : {}),
  };
  return { ...result, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}
