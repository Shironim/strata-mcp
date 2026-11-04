import { withDecisionResponse } from './decision-response';
import { describeResultSelection } from './result-selection';
import { summarizeToolResponse } from './summary-response';
import type { RetrievalEvidence } from '../types';
import { formatRetrievalEvidence, hashRetrievalIdentity } from '../engine/retrieval-evidence';
import { FULL_ENGINE_REVISION } from '../version';
import { applyResponseBudget, MINIMUM_RESPONSE_BUDGET_BYTES } from '../engine/context-budget';
import type { McpToolDefinition, ToolCallResponse } from './types';

/** Fallback metadata never upgrades an uninstrumented result to current/complete. */
export interface RetrievalRequestContext {
  workspace: string | null;
  scope: string | null;
  policy: string;
  query: Record<string, unknown>;
  inputHash?: string;
}

export function withRetrievalEvidence(tool: McpToolDefinition, describe?: (args: Record<string, any>) => RetrievalRequestContext): McpToolDefinition {
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
    try { payload = JSON.parse(result.content[0]?.text ?? ''); } catch { /* Text remains intact. */ }
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
      limitations: ['Null workspace/scope mean effective values were not captured or input is inline, not that analysis is workspace-wide.', request ? 'Query identity uses normalized search selectors; implicit analyzer defaults and matched file versions remain outside this identity.' : 'Query identity hashes supplied arguments; equivalent aliases may have different identities.', 'Retrieval identity is a request/status identity only, not a source snapshot or continuation token.', `Engine revision is hash-bound to runtime package and compiler dependencies (${FULL_ENGINE_REVISION}).`],
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
        { ...result.content[0]!, text: JSON.stringify({ ...payload, retrieval }, null, 2) }, ...result.content.slice(1),
      ] };
    } else {
      result = { ...result, structuredContent, content: [...result.content, { type: 'text', text: isJson ? JSON.stringify({ retrieval }, null, 2) : formatRetrievalEvidence(retrieval) }] };
    }

    return result;
  } };
  return { ...wrapped, handler: async args => {
    const started = performance.now();
    const raw = summarizeToolResponse(await wrapped.handler(args), tool.name, args);
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const render = (candidate: ToolCallResponse): ToolCallResponse => {
      const result = withDecisionResponse(candidate, tool.name, args);
      const cost = { durationMs,
        responseBytes: 0, representation: 'utf8-json-tool-response', volatile: true };
      result.structuredContent = { ...result.structuredContent, cost };
      const costBlock = { type: 'text' as const, text: '' };
      result.content.push(costBlock);
      // Include the size field itself. This converges when the digit count stabilizes.
      for (let i = 0; i < 8; i++) {
        costBlock.text = JSON.stringify({ cost });
        const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        if (bytes === cost.responseBytes) break;
        cost.responseBytes = bytes;
      }
      return result;
    };
    const retrieval = raw.structuredContent?.retrieval as RetrievalEvidence | undefined;
    return applyResponseBudget(raw, {
      tool: tool.name, maxBytes: args.max_bytes ?? args.maxBytes,
      continuationToken: args.continuation_token ?? args.continuationToken,
      format: args.format === 'json' || args.output_format === 'json' ? 'json' : 'text',
      collectionPaths: describeResultSelection(tool.name, args, raw.structuredContent ?? {}).collections,
      render,
      tokenContext: { tool: tool.name, queryId: retrieval?.queryId ?? '', sourceHash: retrieval?.source?.sha256,
        indexGeneration: retrieval?.index?.generation ?? null, configFingerprint: retrieval?.config?.fingerprint ?? null,
        engineRevision: retrieval?.engineRevision ?? FULL_ENGINE_REVISION },
    });
  } };
}
