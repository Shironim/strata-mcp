import type { RetrievalEvidence } from '../types';
import { formatRetrievalEvidence, hashRetrievalIdentity } from '../engine/retrieval-evidence';
import { STRATA_VERSION } from '../version';
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
  return { ...tool, handler: async args => {
    let result: ToolCallResponse;
    try {
      result = await tool.handler(args);
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
    if (result.structuredContent?.retrieval) return result;

    // Status may be returned in a successful MCP envelope (e.g. NOT_INDEXED).
    let payload: unknown;
    try { payload = JSON.parse(result.content[0]?.text ?? ''); } catch { /* Text remains intact. */ }
    const notIndexed = (payload !== null && typeof payload === 'object' && 'status' in payload && payload.status === 'NOT_INDEXED')
      || result.content.some(item => item.text.startsWith('[strata NOT_INDEXED]'));
    const stale = (payload !== null && typeof payload === 'object' && 'status' in payload && payload.status === 'stale')
      || (result.isError === true && result.content.some(item => item.text.includes('STALE_SOURCE_REF:')));
    const code = stale ? 'STALE_SOURCE_REF' : result.isError ? 'TOOL_REQUEST_FAILED' : notIndexed ? 'NOT_INDEXED' : 'RETRIEVAL_INPUTS_UNVERIFIED';
    let request: RetrievalRequestContext | undefined;
    if (!result.isError) {
      try { request = describe?.(args); } catch { /* Invalid context never upgrades evidence. */ }
    }
    const queryId = hashRetrievalIdentity(request ? { tool: tool.name, ...request } : { tool: tool.name, arguments: args });
    const retrieval: RetrievalEvidence = {
      version: 1, workspace: request?.workspace ?? null, scope: request?.scope ?? null, queryId,
      ...(request?.inputHash ? { inputIdentity: { kind: 'inline' as const, hash: request.inputHash, algorithm: 'sha256-canonical-json' as const } } : {}),
      retrievalId: hashRetrievalIdentity({ queryId, engineRevision: STRATA_VERSION, status: code }),
      policy: request?.policy ?? `${tool.name}-fallback-v1`, engineRevision: STRATA_VERSION,
      index: null, config: { applicability: 'unverified', reason: 'This response branch did not capture effective resolver/config inputs.' },
      freshness: stale ? 'stale' : 'unavailable', freshnessBoundary: 'not-verified', completeness: 'partial', basis: 'derived',
      dependencies: { status: 'unverified', reason: 'No hash-bound source/dependency manifest was captured for this response branch.' },
      selectionReason: result.isError ? 'The requested analysis failed; no successful retrieval is asserted.' : notIndexed ? 'Analysis requires workspace initialization.' : 'Caller-requested search/inventory or analysis; effective selection inputs are not yet fully instrumented.',
      omissions: [{ code, reason: result.isError ? 'Inspect the original error response; no current or complete result is established.' : notIndexed ? 'Workspace is not indexed; this is not a zero-match or complete result.' : 'Source snapshots, effective scope and parser identity are not bound to this result.' }],
      limitations: ['Null workspace/scope mean effective values were not captured or input is inline, not that analysis is workspace-wide.', request ? 'Query identity uses normalized search selectors; implicit analyzer defaults and matched file versions remain outside this identity.' : 'Query identity hashes supplied arguments; equivalent aliases may have different identities.', 'Retrieval identity is a request/status identity only, not a source snapshot or continuation token.', 'Package version does not uniquely identify executable or external parser binaries.'],
    };
    const structuredContent = { ...result.structuredContent, retrieval };
    // Preserve array/scalar JSON and exact primary text; metadata is a separate content block.
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { ...result, structuredContent, content: [
        { ...result.content[0]!, text: JSON.stringify({ ...payload, retrieval }, null, 2) }, ...result.content.slice(1),
      ] };
    }
    const isJson = args.format === 'json' || args.output_format === 'json';
    return { ...result, structuredContent, content: [...result.content, { type: 'text', text: isJson ? JSON.stringify({ retrieval }, null, 2) : formatRetrievalEvidence(retrieval) }] };
  } };
}
