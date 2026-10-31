import { createHash } from 'node:crypto';
import type { RetrievalEvidence, SourceSnapshot } from '../types';
import { readSourceSnapshot } from './source-file';
import { STRATA_VERSION } from '../version';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

export function hashRetrievalIdentity(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Rechecks only the selected file. This does not establish an atomic workspace snapshot. */
export async function sourceRetrievalEvidence(options: {
  workspace: string;
  snapshot: SourceSnapshot;
  policy: string;
  query: Record<string, unknown>;
  complete: boolean;
  selectionReason: string;
  omissions?: RetrievalEvidence['omissions'];
}): Promise<RetrievalEvidence> {
  const omissions = [...(options.omissions ?? [])];
  let freshness: RetrievalEvidence['freshness'];
  try {
    const latest = await readSourceSnapshot(options.snapshot.file);
    freshness = latest.snapshot.sha256 === options.snapshot.sha256 ? 'current' : 'stale';
    if (freshness === 'stale') omissions.push({ code: 'SOURCE_CHANGED', reason: 'The selected source changed after selection; retrieve a fresh map.' });
  } catch (error) {
    freshness = 'unavailable';
    omissions.push({ code: 'SOURCE_RECHECK_FAILED', reason: error instanceof Error ? error.message : String(error) });
  }
  const queryId = hashRetrievalIdentity({ workspace: options.workspace, file: options.snapshot.file, policy: options.policy, query: options.query });
  return {
    version: 1, workspace: options.workspace, scope: options.snapshot.file,
    queryId,
    retrievalId: createHash('sha256').update(canonical({ queryId, source: options.snapshot.sha256, engineRevision: STRATA_VERSION })).digest('hex'),
    policy: options.policy, engineRevision: STRATA_VERSION, index: null,
    config: { applicability: 'not-used', reason: 'Direct file map/source selection does not consult the workspace graph or resolver configuration.' },
    source: options.snapshot, freshness, freshnessBoundary: 'source-rechecked-after-selection',
    completeness: options.complete ? 'complete' : 'partial', basis: 'source', selectionReason: options.selectionReason,
    omissions, limitations: ['Completeness covers only the declared file selection policy and parser capabilities.', 'Freshness is checked at read time; this is not an atomic workspace snapshot or a dependency freshness guarantee.', 'Engine revision is the package version; it does not uniquely identify unversioned local source edits.'],
  };
}

export function formatRetrievalEvidence(evidence: RetrievalEvidence): string {
  return [`Retrieval: freshness=${evidence.freshness}; completeness=${evidence.completeness}; policy=${evidence.policy}`,
    ...(evidence.sourceFreshness ? [`Primary source freshness: ${evidence.sourceFreshness}; dependency freshness: ${evidence.dependencies?.status ?? 'not-applicable'}`] : []),
    `Source SHA-256: ${evidence.source?.sha256 ?? 'not-captured'}; query: ${evidence.queryId}`,
    ...(evidence.index ? [`Index: generation=${evidence.index.generation}; consistency=${evidence.index.consistency}; manifest=${evidence.index.manifestHash}`] : []),
    `Selected because: ${evidence.selectionReason}`,
    ...evidence.omissions.map(item => `Omission ${item.code}: ${item.reason}`),
    ...evidence.limitations.map(reason => `Limitation: ${reason}`)].join('\n');
}

/** Until a dependency manifest is captured, primary-file freshness cannot verify derived results. */
export async function derivedRetrievalEvidence(options: Parameters<typeof sourceRetrievalEvidence>[0]): Promise<RetrievalEvidence> {
  const source = await sourceRetrievalEvidence({ ...options, complete: false });
  return {
    ...source, basis: 'derived', sourceFreshness: source.freshness,
    freshness: source.freshness === 'stale' ? 'stale' : 'unavailable',
    config: { applicability: 'unverified', reason: 'Resolver/framework configuration used by derived analysis is not captured in a hash-bound manifest.' },
    dependencies: { status: 'unverified', reason: 'Imported types, resolver inputs and secondary analysis reads are not captured in a single dependency snapshot.' },
    omissions: [...source.omissions, { code: 'DERIVED_INPUTS_UNVERIFIED', reason: 'Primary source identity does not verify all inputs used by derived analysis.' }],
    limitations: [...source.limitations, 'Retrieval identity binds the query and primary source only; it is not a reproducibility identity for the derived dependency closure.'],
  };
}
