import type { ContinuationTokenPayload } from '../types';
import type { ToolCallResponse } from '../tools/types';
import { hashRetrievalIdentity } from './retrieval-evidence';

export const MINIMUM_RESPONSE_BUDGET_BYTES = 512;
export const RESERVED_ENVELOPE_BYTES = 256;

export interface ContextBudgetOptions {
  maxBytes?: number;
  maxItems?: number;
  offset?: number;
  continuationToken?: string;
  tokenContext?: {
    tool: string;
    queryId: string;
    sourceHash?: string;
    indexGeneration?: string | null;
    configFingerprint?: string | null;
    engineRevision: string;
  };
  reservedEnvelopeBytes?: number;
}

export interface BudgetedResult<T> {
  items: T[];
  totalAvailable: number;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
  isTruncated: boolean;
  continuationToken?: string;
  estimatedBytes: number;
}

/**
 * Encodes a continuation token payload into a compact, URL-safe base64 string.
 */
export function encodeContinuationToken(payload: ContinuationTokenPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes and rigorously verifies a continuation token against the active retrieval context.
 * Rejects stale or invalid tokens with descriptive errors.
 */
export function decodeAndVerifyContinuationToken(
  token: string,
  expected: {
    tool: string;
    queryId: string;
    sourceHash?: string;
    indexGeneration?: string | null;
    configFingerprint?: string | null;
    engineRevision?: string;
    selectionHash?: string;
  }
): { valid: boolean; offset: number; error?: string } {
  let payload: ContinuationTokenPayload;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    payload = JSON.parse(raw);
  } catch {
    return { valid: false, offset: 0, error: 'INVALID_CONTINUATION_TOKEN: token is malformed or unparseable' };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, offset: 0, error: 'INVALID_CONTINUATION_TOKEN: expected an object payload' };
  }
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || !Number.isSafeInteger(payload.totalItems) || payload.totalItems < payload.offset) {
    return { valid: false, offset: 0, error: 'INVALID_CONTINUATION_TOKEN: invalid offset or totalItems' };
  }
  if (payload.version !== 1) {
    return { valid: false, offset: 0, error: `UNSUPPORTED_CONTINUATION_VERSION: received version ${payload.version}, expected 1` };
  }

  if (payload.tool !== expected.tool) {
    return { valid: false, offset: 0, error: `INVALID_CONTINUATION_TOKEN: token tool "${payload.tool}" does not match requested tool "${expected.tool}"` };
  }

  if (payload.queryId !== expected.queryId) {
    return { valid: false, offset: 0, error: 'INVALID_CONTINUATION_TOKEN: query parameters changed since continuation token was issued' };
  }

  if ('sourceHash' in expected && (payload.sourceHash ?? null) !== (expected.sourceHash ?? null)) {
    return { valid: false, offset: 0, error: 'STALE_CONTINUATION_TOKEN: source file changed since continuation token was issued; retrieve fresh' };
  }

  if ('indexGeneration' in expected && (payload.indexGeneration ?? null) !== (expected.indexGeneration ?? null)) {
    return { valid: false, offset: 0, error: 'STALE_CONTINUATION_TOKEN: database index generation changed since continuation token was issued; retrieve fresh' };
  }

  if ('configFingerprint' in expected && (payload.configFingerprint ?? null) !== (expected.configFingerprint ?? null)) {
    return { valid: false, offset: 0, error: 'STALE_CONTINUATION_TOKEN: configuration fingerprint changed since continuation token was issued; retrieve fresh' };
  }

  if ('engineRevision' in expected && payload.engineRevision !== expected.engineRevision) {
    return { valid: false, offset: 0, error: 'STALE_CONTINUATION_TOKEN: engine revision changed since continuation token was issued; retrieve fresh' };
  }

  if ('selectionHash' in expected && payload.selectionHash !== expected.selectionHash) {
    return { valid: false, offset: 0, error: 'STALE_CONTINUATION_TOKEN: result selection changed or identity is missing; retrieve fresh' };
  }

  return { valid: true, offset: payload.offset };
}

/**
 * Sorts items deterministically based on their intrinsic attributes (depth, isPage, path/file, line, column, name)
 * to eliminate dependence on SQLite auto-increment IDs or non-deterministic OS directory iteration.
 */
export function sortDeterministically<T>(items: T[]): T[] {
  return [...items].sort((a: any, b: any) => {
    if (!a || !b) return 0;
    // 1. Sort by depth if present
    if (typeof a.depth === 'number' && typeof b.depth === 'number') {
      if (a.depth !== b.depth) return a.depth - b.depth;
    }
    // 2. Sort by isPage / is_page if present (pages first)
    const aPage = a.isPage ?? a.is_page ?? 0;
    const bPage = b.isPage ?? b.is_page ?? 0;
    if (aPage !== bPage) return bPage - aPage;

    // 3. Sort by path / file / filePath
    const aPath = a.path ?? a.file ?? a.filePath ?? '';
    const bPath = b.path ?? b.file ?? b.filePath ?? '';
    if (aPath !== bPath) return String(aPath).localeCompare(String(bPath));

    // 4. Sort by line / startLine / offset
    const aLine = a.startLine ?? a.line ?? a.range?.startOffset ?? a.offset ?? 0;
    const bLine = b.startLine ?? b.line ?? b.range?.startOffset ?? b.offset ?? 0;
    if (aLine !== bLine) return aLine - bLine;

    // 5. Sort by column / startColumn / endOffset
    const aCol = a.startColumn ?? a.column ?? a.range?.endOffset ?? 0;
    const bCol = b.startColumn ?? b.column ?? b.range?.endOffset ?? 0;
    if (aCol !== bCol) return aCol - bCol;

    // 6. Sort by name / identifier / symbol
    const aName = a.name ?? a.identifier ?? a.symbol ?? '';
    const bName = b.name ?? b.identifier ?? b.symbol ?? '';
    if (aName !== bName) return String(aName).localeCompare(String(bName));

    // Fallback: deterministic JSON comparison
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
}

/**
 * Applies structured byte and item budgeting to a collection of items.
 * Estimates item bytes with an explicit reserve. Full API results must use applyResponseBudget.
 */
export function applyContextBudget<T>(
  items: T[],
  options: ContextBudgetOptions = {}
): BudgetedResult<T> {
  const { maxBytes, maxItems, tokenContext } = options;
  const reservedEnvelope = options.reservedEnvelopeBytes ?? RESERVED_ENVELOPE_BYTES;

  if (maxBytes !== undefined && !Number.isSafeInteger(maxBytes)) throw new Error('INVALID_RESPONSE_BUDGET: max_bytes must be a finite safe integer');
  if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 1)) throw new Error('INVALID_ITEM_LIMIT: maxItems must be a positive safe integer');
  if (maxBytes !== undefined && maxBytes < MINIMUM_RESPONSE_BUDGET_BYTES) {
    throw new Error(`BUDGET_TOO_SMALL: max_bytes (${maxBytes}) must be at least ${MINIMUM_RESPONSE_BUDGET_BYTES} bytes to preserve mandatory context metadata`);
  }

  let startOffset = options.offset ?? 0;
  const selectionHash = hashRetrievalIdentity(items);

  if (options.continuationToken && tokenContext) {
    const verification = decodeAndVerifyContinuationToken(options.continuationToken, { ...tokenContext, selectionHash });
    if (!verification.valid) {
      throw new Error(verification.error || 'INVALID_CONTINUATION_TOKEN');
    }
    startOffset = verification.offset;
  }

  const boundedStart = Math.max(0, Math.min(startOffset, items.length));
  const candidateSlice = items.slice(boundedStart);

  const included: T[] = [];
  let currentBytes = 0;
  let isTruncated = false;
  let nextIdx = boundedStart;

  for (let i = 0; i < candidateSlice.length; i++) {
    const item = candidateSlice[i];
    if (maxItems !== undefined && included.length >= maxItems) {
      isTruncated = true;
      break;
    }

    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');

    if (maxBytes !== undefined) {
      if (currentBytes + itemBytes + reservedEnvelope > maxBytes) {
        if (included.length === 0) throw new Error('BUDGET_ITEM_TOO_LARGE: one complete item cannot fit; increase max_bytes or narrow the request');
        isTruncated = true;
        break;
      }
    }

    included.push(item);
    currentBytes += itemBytes;
    nextIdx = boundedStart + i + 1;
  }

  const hasMore = nextIdx < items.length;
  let continuationToken: string | undefined;

  if (hasMore && tokenContext) {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: tokenContext.tool,
      queryId: tokenContext.queryId,
      sourceHash: tokenContext.sourceHash,
      indexGeneration: tokenContext.indexGeneration,
      configFingerprint: tokenContext.configFingerprint,
      engineRevision: tokenContext.engineRevision,
      selectionHash,
      offset: nextIdx,
      totalItems: items.length,
      issuedAt: Date.now(),
    };
    continuationToken = encodeContinuationToken(tokenPayload);
  }

  return {
    items: included,
    totalAvailable: items.length,
    offset: boundedStart,
    nextOffset: hasMore ? nextIdx : undefined,
    hasMore,
    isTruncated: isTruncated || hasMore,
    continuationToken,
    estimatedBytes: currentBytes,
  };
}

export interface ResponseBudgetOptions {
  tool: string;
  maxBytes?: number;
  continuationToken?: string;
  format?: 'text' | 'json';
  collectionPaths?: string[];
  render?: (result: ToolCallResponse) => ToolCallResponse;
  tokenContext: {
    tool: string;
    queryId: string;
    sourceHash?: string;
    indexGeneration?: string | null;
    configFingerprint?: string | null;
    engineRevision: string;
  };
}

export const TARGET_COLLECTION_KEYS = [
  'matches',
  'files',
  'regions',
  'consumers',
  'routes',
  'usages',
  'diagnostics',
  'patches',
  'violations',
  'outline',
  'items',
  'data',
] as const;

/** UTF-8 JSON ToolCallResponse bytes, including duplicated content/structuredContent. */
export function measureResponseBytes(result: ToolCallResponse): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/** Small, actionable rejection when mandatory evidence or one atomic item cannot fit. */
function budgetRejection(code: string, maxBytes: number, requiredBytes: number, original?: ToolCallResponse): ToolCallResponse {
  const originalCode = original?.isError ? original.content[0]?.text.match(/\b[A-Z][A-Z_]+(?=:)/)?.[0]?.slice(0, 48) : undefined;
  const result: ToolCallResponse = {
    isError: true,
    content: [{ type: 'text', text: `${code}: increase max_bytes or narrow scope; no complete analysis payload fits.${originalCode ? ` Original: ${originalCode}.` : ''}` }],
    structuredContent: {
      decision: { status: (original?.structuredContent?.retrieval as any)?.freshness === 'stale' ? 'stale' : 'unknown', emptyOutcome: 'analysis-failed', next: [{ action: 'increase-budget-or-narrow-scope' }] },
      budget: { maxBytes, requiredBytes, retryMaxBytes: Math.min(Number.MAX_SAFE_INTEGER, requiredBytes + 128), responseBytes: 0 },
    },
  };
  const budget = result.structuredContent!.budget as { responseBytes: number };
  for (let i = 0; i < 8; i++) {
    const bytes = measureResponseBytes(result);
    if (budget.responseBytes === bytes) break;
    budget.responseBytes = bytes;
  }
  return result;
}

/** Final guard for transport failures that bypass the analysis handler. Excludes JSON-RPC framing. */
export function enforceResponseLimit(result: ToolCallResponse, maxBytes: unknown): ToolCallResponse {
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < MINIMUM_RESPONSE_BUDGET_BYTES) return result;
  const bytes = measureResponseBytes(result);
  return bytes <= maxBytes ? result : budgetRejection('BUDGET_RESPONSE_TOO_LARGE', maxBytes, bytes, result);
}

function getPath(data: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<any>((value, key) => value?.[key], data);
}
function setPath(data: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<any>((item, key) => item[key], data);
  parent[last] = value;
}

/**
 * Measures the FINAL rendered response, not a fixed allowance per item.
 * Only one explicitly selected collection is pageable. Other mandatory payloads remain atomic.
 */
export function applyResponseBudget(result: ToolCallResponse, options: ResponseBudgetOptions): ToolCallResponse {
  const { maxBytes, continuationToken, tokenContext } = options;
  const render = options.render ?? ((value: ToolCallResponse) => value);
  if (maxBytes === undefined && !continuationToken) return render(result);
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < MINIMUM_RESPONSE_BUDGET_BYTES)) {
    return render({ isError: true, content: [{ type: 'text', text: `BUDGET_TOO_SMALL: max_bytes must be an integer >= ${MINIMUM_RESPONSE_BUDGET_BYTES}` }] });
  }
  const fitOrReject = (candidate: ToolCallResponse): ToolCallResponse => {
    const bytes = measureResponseBytes(candidate);
    return maxBytes === undefined || bytes <= maxBytes ? candidate
      : budgetRejection('BUDGET_RESPONSE_TOO_LARGE', maxBytes, bytes, candidate);
  };
  if (result.isError) return fitOrReject(render(result));

  const original = result.structuredContent ?? {};
  const paths = options.collectionPaths ?? [...TARGET_COLLECTION_KEYS].filter(key => Array.isArray(original[key])).slice(0, 1);
  const path = paths.length === 1 && Array.isArray(getPath(original, paths[0]!)) ? paths[0] : undefined;
  const items = path ? sortDeterministically(getPath(original, path) as unknown[]) : [];
  // Bind all pages to the same ordered selection, including nested subtree content.
  // This does not claim that every analyzer input/dependency has been captured.
  const selectionHash = hashRetrievalIdentity({ path, items });
  const rejectContinuation = (message: string): ToolCallResponse => {
    const failure = structuredClone(result);
    failure.isError = true;
    failure.content = [{ type: 'text', text: message }];
    const retrieval = failure.structuredContent?.retrieval as any;
    if (retrieval) {
      if (message.startsWith('STALE_CONTINUATION_TOKEN')) retrieval.freshness = 'stale';
      retrieval.omissions ??= [];
      retrieval.omissions.push({ code: 'CONTINUATION_REJECTED', reason: message });
    }
    // Rejected pages must not carry fresh analysis items or overflow the error budget.
    failure.structuredContent = retrieval ? { retrieval } : {};
    return fitOrReject(render(failure));
  };
  let start = 0;
  if (continuationToken) {
    const verification = decodeAndVerifyContinuationToken(continuationToken, { ...tokenContext, selectionHash });
    if (!verification.valid) {
      return rejectContinuation(verification.error!);
    }
    start = verification.offset;
  }
  if (continuationToken && !path) return rejectContinuation('INVALID_CONTINUATION_TOKEN: this result has no single pageable collection; repeat without token');
  const mirrorsMatches = path === 'matches' && Array.isArray(original.data)
    && JSON.stringify(original.data) === JSON.stringify(getPath(original, path));
  if (path && continuationToken) {
    const payload = JSON.parse(Buffer.from(continuationToken, 'base64url').toString('utf8')) as ContinuationTokenPayload;
    if (payload.totalItems !== items.length || start > items.length) return rejectContinuation('STALE_CONTINUATION_TOKEN: collection size changed; retrieve fresh');
  }

  const build = (end: number): ToolCallResponse => {
    const candidate = structuredClone(result);
    const data = candidate.structuredContent ?? {};
    const hasMore = Boolean(path && end < items.length);
    const partial = Boolean(path && (start > 0 || hasMore));
    let token: string | undefined;
    if (path) {
      const page = items.slice(start, end);
      setPath(data, path, page);
      // Legacy array JSON may be mirrored as data; retain it only as the same selected page.
      if (mirrorsMatches) data.data = page;
      if (path === 'matches') { data.matchCount = page.length; data.totalMatches = items.length; }
      if (path === 'matches' && data.coverage && typeof data.coverage === 'object') Object.assign(data.coverage, { returned: page.length });
      if (path === 'files' && data.coverage && typeof data.coverage === 'object') Object.assign(data.coverage, {
        returnedFiles: page.length, offset: Number((original.coverage as any)?.offset ?? 0) + start,
      });
      data.totalAvailable = items.length;
      data.offset = start;
      data.hasMore = hasMore;
      const previouslyTruncated = Boolean(original.truncated || original.isTruncated || original.is_truncated || (original.coverage as any)?.truncated);
      data.is_truncated = data.isTruncated = partial || previouslyTruncated;
      delete data.continuationToken;
      delete data.nextOffset;
      if (hasMore) {
        token = encodeContinuationToken({ version: 1, ...tokenContext, selectionHash, offset: end, totalItems: items.length, issuedAt: 0 });
        data.continuationToken = token;
        data.nextOffset = end;
      }
    }
    const budget = { maxBytes, estimatedBytes: 0, isTruncated: partial, consistency: 'selection-bound', ...(token ? { continuationToken: token } : {}) };
    const retrieval = data.retrieval as any;
    if (retrieval) {
      retrieval.budget = budget;
      if (partial) {
        retrieval.completeness = 'partial';
        retrieval.omissions ??= [];
        retrieval.omissions.push({ code: 'CONTEXT_BUDGET_EXCEEDED', reason: `Paginated selection: entries ${start} through ${end} of ${items.length}. Excluded entries are not evidence of absence.` });
      }
    } else data.budget = budget;
    candidate.structuredContent = data;
    let rendered = candidate;
    // Include the byte-count field itself in both representations until its digits stabilize.
    for (let i = 0; i < 8; i++) {
      if (path) {
        const extras = result.content.slice(1).filter(block => {
          if (block.text.startsWith('Retrieval:')) return false;
          try { const parsed = JSON.parse(block.text); return !(parsed && Object.keys(parsed).length === 1 && parsed.retrieval); } catch { return true; }
        });
        candidate.content = [{ type: 'text', text: JSON.stringify(data) }, ...extras];
      } else candidate.content = [...result.content, { type: 'text', text: JSON.stringify({ budget }) }];
      rendered = render(candidate);
      const bytes = measureResponseBytes(rendered);
      if (budget.estimatedBytes === bytes) break;
      budget.estimatedBytes = bytes;
    }
    return rendered;
  };

  const full = build(items.length);
  if (maxBytes === undefined || measureResponseBytes(full) <= maxBytes) return full;
  if (!path || start === items.length) return budgetRejection('BUDGET_METADATA_TOO_LARGE', maxBytes, measureResponseBytes(full));
  const minimum = build(start);
  const one = build(start + 1);
  if (measureResponseBytes(minimum) > maxBytes) return budgetRejection('BUDGET_METADATA_TOO_LARGE', maxBytes, measureResponseBytes(one));
  if (measureResponseBytes(one) > maxBytes) return budgetRejection('BUDGET_ITEM_TOO_LARGE', maxBytes, measureResponseBytes(one));
  let low = start + 1;
  let high = items.length - 1;
  let best = one;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const page = build(middle);
    if (measureResponseBytes(page) <= maxBytes) { best = page; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}
