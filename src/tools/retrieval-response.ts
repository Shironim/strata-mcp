import { withDecisionResponse } from './decision-response';
import { describeResultSelection } from './result-selection';
import { summarizeToolResponse } from './summary-response';
import type { RetrievalEvidence } from '../types';
import { formatRetrievalEvidence, hashRetrievalIdentity } from '../engine/retrieval-evidence';
import { FULL_ENGINE_REVISION } from '../version';
import { applyResponseBudget, DEFAULT_RESPONSE_BUDGET_BYTES, MINIMUM_RESPONSE_BUDGET_BYTES, type PaginatedPageContext } from '../engine/context-budget';
import type { McpToolDefinition, ToolCallResponse } from './types';

/** Fallback metadata never upgrades an uninstrumented result to current/complete. */
export interface RetrievalRequestContext {
  workspace: string | null;
  scope: string | null;
  policy: string;
  query: Record<string, unknown>;
  inputHash?: string;
}

export interface RetrievalWrapperOptions {
  describe?: (args: Record<string, any>) => RetrievalRequestContext;
  formatText?: (data: Record<string, any>, page: PaginatedPageContext, args: Record<string, any>) => string | undefined;
}

export function withRetrievalEvidence(
  tool: McpToolDefinition,
  describeOrOptions?: ((args: Record<string, any>) => RetrievalRequestContext) | RetrievalWrapperOptions
): McpToolDefinition {
  const options: RetrievalWrapperOptions = typeof describeOrOptions === 'function'
    ? { describe: describeOrOptions }
    : (describeOrOptions ?? {});
  const describe = options.describe;
  const wrapped: McpToolDefinition = { ...tool, handler: async args => {
    if (args.response_detail !== undefined && !['summary', 'full'].includes(args.response_detail))
      return { isError: true, content: [{ type: 'text', text: "INVALID_RESPONSE_DETAIL: response_detail must be 'summary' or 'full'." }] };
    if (args.response_detail === 'summary' && (args.continuation_token || args.continuationToken))
      return { isError: true, content: [{ type: 'text', text: 'SUMMARY_CONTINUATION_UNSUPPORTED: use response_detail full when continuing a page.' }] };
    if (args.response_detail === 'summary' && tool.name === 'inspect_component' && (args.view === 'source' || args.source_range || args.sfc_sections))
      return { isError: true, content: [{ type: 'text', text: 'EXACT_SOURCE_REQUIRES_FULL: use response_detail full for exact source retrieval.' }] };
    const maxBytes = args.max_bytes ?? args.maxBytes;
    if (maxBytes !== undefined && !Number.isSafeInteger(maxBytes)) {
      return { isError: true, content: [{ type: 'text', text: 'INVALID_RESPONSE_BUDGET: max_bytes must be a finite safe integer >= 512' }] };
    }
    if (maxBytes !== undefined && maxBytes < MINIMUM_RESPONSE_BUDGET_BYTES) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `BUDGET_TOO_SMALL: max_bytes (${maxBytes}) must be at least ${MINIMUM_RESPONSE_BUDGET_BYTES} bytes to preserve mandatory context metadata`,
        }],
      };
    }

    let result: ToolCallResponse;
    try {
      result = await tool.handler(args);
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }

    const isJson = args.format === 'json' || args.output_format === 'json';

    // Budgeting happens only after all evidence and decision metadata are available.
    if (result.structuredContent?.retrieval) {
      return result;
    }

    // Status may be returned in a successful MCP envelope (e.g. NOT_INDEXED).
    let payload: unknown;
    try {
      if (!(tool.name === 'inspect_component' && (args.view === 'source' || args.source_range || args.sfc_sections)))
        payload = JSON.parse(result.content[0]?.text ?? '');
    } catch { /* Text remains intact. */ }
    const notIndexed = (payload !== null && typeof payload === 'object' && 'status' in payload && payload.status === 'NOT_INDEXED')
      || result.content.some(item => item.text.startsWith('[strata NOT_INDEXED]'));
    const stale = result.structuredContent?.inputFreshness === 'stale'
      || (payload !== null && typeof payload === 'object' && 'status' in payload && payload.status === 'stale')
      || (result.isError === true && result.content.some(item => item.text.includes('STALE_SOURCE_REF:')));
    const code = stale ? 'STALE_SOURCE_REF' : result.isError ? 'TOOL_REQUEST_FAILED' : notIndexed ? 'NOT_INDEXED' : 'RETRIEVAL_INPUTS_UNVERIFIED';
    const isTruncated = Boolean(
      (result.structuredContent && (result.structuredContent as any).truncated) ||
      (result.structuredContent && (result.structuredContent as any).coverage?.truncated) ||
      (payload && typeof payload === 'object' && ((payload as any).truncated || (payload as any).coverage?.truncated))
    );
    let request: RetrievalRequestContext | undefined;
    if (!result.isError) {
      try { request = describe?.(args); } catch { /* Invalid context never upgrades evidence. */ }
    }
    const { continuation_token, continuationToken, offset, max_bytes: mb1, maxBytes: mb2, ...cleanArgs } = args;
    const queryId = hashRetrievalIdentity(request ? { tool: tool.name, ...request } : { tool: tool.name, arguments: cleanArgs });
    const retrieval: RetrievalEvidence = {
      version: 1, workspace: request?.workspace ?? null, scope: request?.scope ?? null, queryId,
      ...(request?.inputHash ? { inputIdentity: { kind: 'inline' as const, hash: request.inputHash, algorithm: 'sha256-canonical-json' as const } } : {}),
      retrievalId: hashRetrievalIdentity({ queryId, engineRevision: FULL_ENGINE_REVISION, status: code }),
      policy: request?.policy ?? `${tool.name}-fallback-v1`, engineRevision: FULL_ENGINE_REVISION,
      index: null, config: { applicability: 'unverified', reason: 'This response branch did not capture effective resolver/config inputs.' },
      freshness: stale ? 'stale' : 'unavailable', freshnessBoundary: 'not-verified', completeness: 'partial', basis: 'derived',
      dependencies: { status: 'unverified', reason: 'No hash-bound source/dependency manifest was captured for this response branch.' },
      selectionReason: result.isError ? 'The requested analysis failed; no successful retrieval is asserted.' : notIndexed ? 'Analysis requires workspace initialization.' : 'Caller-requested search/inventory or analysis; effective selection inputs are not yet fully instrumented.',
      omissions: [
        { code, reason: result.isError ? 'Inspect the original error response; no current or complete result is established.' : notIndexed ? 'Workspace is not indexed; this is not a zero-match or complete result.' : 'Source snapshots, effective scope and parser identity are not bound to this result.' },
        ...(isTruncated ? [{ code: 'MAX_RESULTS_TRUNCATED', reason: 'Search results were truncated by caller limit/max_results.' }] : []),
      ],
      limitations: ['Null scope does not imply workspace-wide coverage. Query/retrieval IDs are request identities, not source snapshots or continuation tokens.', request ? 'Implicit defaults and matched file versions are outside query identity.' : 'Aliases may have different query identities.'],
    };
    const structuredContent = {
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}),
      ...(Array.isArray(payload) ? { data: payload, matchCount: payload.length } : {}),
      ...result.structuredContent,
      retrieval,
    };
    // Preserve array/scalar JSON and exact primary text; metadata is a separate content block.
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      result = { ...result, structuredContent, content: [
        ...result.content,
      ] };
    } else {
      result = { ...result, structuredContent, content: [...result.content, { type: 'text', text: isJson ? JSON.stringify({ retrieval }) : formatRetrievalEvidence(retrieval) }] };
    }

    return result;
  } };
  return { ...wrapped, handler: async args => {
    const raw = summarizeToolResponse(await wrapped.handler(args), tool.name, args);
    const render = (candidate: ToolCallResponse): ToolCallResponse => {
      const result = withDecisionResponse(candidate, tool.name, args);
      // JSON object responses carry one text mirror for MCP clients without structuredContent.
      // Exact source, arrays and human-readable primary output keep their original first block.
      let objectPrimary = false;
      try {
        const primary = JSON.parse(result.content[0]?.text ?? '');
        objectPrimary = primary !== null && typeof primary === 'object' && !Array.isArray(primary);
      } catch { /* Exact source and plain text are never reformatted. */ }
      if (objectPrimary && !(tool.name === 'inspect_component' && (args.view === 'source' || args.source_range || args.sfc_sections))) {
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
          const isExactSource = tool.name === 'inspect_component' && (args.view === 'source' || args.source_range !== undefined);
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
    const retrieval = raw.structuredContent?.retrieval as RetrievalEvidence | undefined;
    return applyResponseBudget(raw, {
      tool: tool.name, maxBytes: args.max_bytes ?? args.maxBytes ?? DEFAULT_RESPONSE_BUDGET_BYTES,
      continuationToken: args.continuation_token ?? args.continuationToken,
      format: args.format === 'json' || args.output_format === 'json' ? 'json' : 'text',
      collectionPaths: describeResultSelection(tool.name, args, raw.structuredContent ?? {}).collections,
      formatText: options.formatText
        ? (data, page) => options.formatText!(data, page, args)
        : undefined,
      render,
      tokenContext: { tool: tool.name, queryId: retrieval?.queryId ?? '', sourceHash: retrieval?.source?.sha256,
        indexGeneration: retrieval?.index?.generation ?? null, configFingerprint: retrieval?.config?.fingerprint ?? null,
        engineRevision: retrieval?.engineRevision ?? FULL_ENGINE_REVISION },
    });
  } };
}
