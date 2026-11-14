import { withDecisionResponse } from './decision-response';
import type { RetrievalEvidence } from '../types';
import type { ToolCallResponse } from './types';
import { isExactSourceRequest } from './request';

function isObjectPrimary(text: string): boolean {
  try {
    const primary: unknown = JSON.parse(text);
    return primary !== null && typeof primary === 'object' && !Array.isArray(primary);
  } catch { return false; }
}

export function createResponseRenderer(tool: string, args: Record<string, any>, original: ToolCallResponse) {
  const exactSource = isExactSourceRequest(tool, args);
  const originalText = original.content[0]?.text ?? '';
  const originalObject = !exactSource && isObjectPrimary(originalText);
  return (candidate: ToolCallResponse): ToolCallResponse => {
    const result = withDecisionResponse(candidate, tool, args);
    // JSON object responses carry one text mirror for MCP clients without structuredContent.
    // Exact source, arrays and human-readable primary output keep their original first block.
    const primaryText = result.content[0]?.text ?? '';
    const paginatedObject = candidate.structuredContent?.totalAvailable !== undefined
      && candidate.structuredContent?.offset !== undefined && args.format === 'json';
    const objectPrimary = !exactSource && (primaryText === originalText ? originalObject
      : !candidate.isError && paginatedObject ? true : isObjectPrimary(primaryText));
    if (objectPrimary) {
      const extras = candidate.content.slice(1).filter(block => {
        if (block.text.startsWith('Retrieval:')) return false;
        try {
          const data = JSON.parse(block.text);
          return !(data && Object.keys(data).length === 1 && (data.retrieval || data.budget || data.decision));
        } catch { return true; }
      });
      const { decision, ...payload } = result.structuredContent as Record<string, any>;
      // Clients receive detailed capability declarations in structuredContent; the text
      // mirror needs only the result decision and actionable recovery, not that catalog.
      const textDecision = { status: decision.status, emptyOutcome: decision.emptyOutcome,
        selection: decision.selection, next: decision.next,
        capability: { operation: decision.capability.operation, status: decision.capability.status, validation: decision.capability.validation,
          limitations: Array.from(new Set([...decision.capability.features.filter((item: any) => item.status !== 'supported').map((item: any) => item.reason), ...decision.capability.limitations])) } };

      // For JSON text mirror sent to LLM prompt, compact bulky audit provenance unless explicitly requested.
      // Machine evaluators (Toolbench) and programmatic clients still receive full evidence in structuredContent.
      const fullProvenance = args.include_provenance === true || args.provenance === true || args.metadata_detail === 'full';
      const isJsonMode = args.format === 'json' || args.output_format === 'json';
      const textRetrieval = (payload.retrieval && isJsonMode && !fullProvenance)
        ? {
            freshness: payload.retrieval.freshness,
            completeness: payload.retrieval.completeness,
            policy: payload.retrieval.policy,
            engineRevision: payload.retrieval.engineRevision,
            index: payload.retrieval.index !== undefined ? payload.retrieval.index : null,
            ...(payload.retrieval.config ? { config: payload.retrieval.config } : {}),
            ...(payload.retrieval.dependencies?.status
              ? { dependencies: { status: payload.retrieval.dependencies.status, count: payload.retrieval.dependencies.count } }
              : {}),
            ...(payload.retrieval.omissions && payload.retrieval.omissions.length > 0
              ? { omissions: payload.retrieval.omissions }
              : {}),
          }
        : payload.retrieval;

      const textPayload = {
        ...payload,
        ...(textRetrieval ? { retrieval: textRetrieval } : {}),
        decision: textDecision,
      };
      result.content = [{ type: 'text', text: JSON.stringify(textPayload) }, ...extras];
    } else {
      const decision = result.structuredContent.decision;
      const { status, emptyOutcome, selection, next } = decision;
      const isJsonMode = args.format === 'json' || args.output_format === 'json';
      const fullProvenance = args.include_provenance === true || args.provenance === true || args.metadata_detail === 'full';
      const dataObj = result.structuredContent as Record<string, any>;
      const isBudgetTruncated = Boolean(
        dataObj?.budget?.isTruncated ||
        dataObj?.retrieval?.budget?.isTruncated ||
        dataObj?.continuationToken
      );
      const compactOk =
        !isJsonMode &&
        !fullProvenance &&
        status === 'ok' &&
        !result.isError &&
        !dataObj?.resultSummary &&
        !isBudgetTruncated;

      if (compactOk) {
        const isExactSource = isExactSourceRequest(tool, args);
        // Collapse duplicate trailing Retrieval lines/blocks into one compact status footer.
        const cleanedContent = result.content
          .filter((block, idx) => !(idx > 0 && block.text.startsWith('Retrieval: status=')))
          .map((block, idx) => {
            if (idx === 0 && !isExactSource) {
              return { ...block, text: block.text.replace(/\n{1,2}Retrieval: status=[^\n]+$/, '') };
            }
            return block;
          });
        const retrievalObj = dataObj?.retrieval as RetrievalEvidence | undefined;
        const shaPrefix = retrievalObj?.source?.sha256 ? `sha256:${retrievalObj.source.sha256.slice(0, 12)}` : undefined;
        const rangeLabel = dataObj?.startLine !== undefined && dataObj?.endLine !== undefined
          ? `L${dataObj.startLine}-${dataObj.endLine}${dataObj.clamped && dataObj.requestedEndLine ? ` (clamped to EOF from L${dataObj.requestedEndLine})` : ''}`
          : dataObj?.source_ref?.startOffset !== undefined && dataObj?.source_ref?.endOffset !== undefined
            ? `offsets:${dataObj.source_ref.startOffset}-${dataObj.source_ref.endOffset}`
            : selection?.count !== null && selection?.count !== undefined
              ? `${selection.subject}=${selection.count}`
              : undefined;
        const parts = ['strata: ok', decision.capability.operation, shaPrefix, rangeLabel].filter(Boolean);
        result.content = [...cleanedContent, { type: 'text', text: `[${parts.join(' | ')}]` }];
      } else {
        const clampedLine = dataObj?.clamped && dataObj?.requestedEndLine
          ? `\nNote: end_line ${dataObj.requestedEndLine} clamped to EOF (L${dataObj.endLine}).`
          : '';
        const metadata = isJsonMode
          ? JSON.stringify({ decision })
          : `Decision: ${status}; empty=${emptyOutcome}\nSelection: ${selection.subject}; count=${selection.count ?? 'unknown'}. ${selection.boundary}\nCapability: ${decision.capability.syntax}/${decision.capability.operation}=${decision.capability.status}; framework version unknown\n${Array.from(new Set([...decision.capability.features.filter(item => item.status !== 'supported').map(item => item.reason), ...decision.capability.limitations])).map(reason => `Capability limit: ${reason}`).join('\n')}\n${next.map(item => `Next: ${item.action}: ${item.reason}`).join('\n')}${clampedLine}`;
        result.content = [...result.content, { type: 'text', text: metadata }];
      }
    }
    return result;
  };

}
