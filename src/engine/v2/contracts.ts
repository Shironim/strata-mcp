import type { Database } from 'bun:sqlite';
import type { SemanticProjectPool } from './semantic';

export type VerificationTier = 'graph' | 'semantic' | 'syntax-fallback';

export interface OmissionRecord {
  code: string;
  filePath: string;
  line: number;
  column: number;
  reason: string;
  sourceRef?: string;
}

export interface DiagnosticRecord {
  code: string;
  message: string;
  filePath?: string;
}

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface QueryEnvelope<TData> {
  scope: string;
  verification: VerificationTier;
  data: TData;
  pagination?: PaginationMeta;
  omissions: OmissionRecord[];
  diagnostics: DiagnosticRecord[];
}

export interface ServiceRuntimeOptions {
  db?: Database;
  dbFilename?: string;
  semanticPool?: SemanticProjectPool;
  /** Skip automatic incremental sync before querying (useful when caller already synced). */
  skipSync?: boolean;
}

/**
 * Pure cursor encoder/decoder for deterministic offset pagination.
 */
export function encodeOffsetCursor(offset: number): string {
  return `o_${Math.max(0, Math.trunc(offset))}`;
}

export function decodeOffsetCursor(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^o_(\d+)$/.exec(cursor.trim());
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Pure pagination helper used uniformly across all services (SSOT).
 */
export function paginateItems<T>(
  items: readonly T[],
  limit: number,
  cursor?: string
): { page: T[]; pagination: PaginationMeta } {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const offset = decodeOffsetCursor(cursor);
  const page = items.slice(offset, offset + safeLimit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;

  return {
    page,
    pagination: {
      total: items.length,
      limit: safeLimit,
      offset,
      hasMore,
      nextCursor: hasMore ? encodeOffsetCursor(nextOffset) : null,
    },
  };
}
