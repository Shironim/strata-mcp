import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { InputDependency, RetrievalEvidence, SourceSnapshot } from '../types';
import { readSourceFile, readSourceSnapshot } from './source-file';
import { FULL_ENGINE_REVISION } from '../version';

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
    retrievalId: createHash('sha256').update(canonical({ queryId, source: options.snapshot.sha256, engineRevision: FULL_ENGINE_REVISION })).digest('hex'),
    policy: options.policy, engineRevision: FULL_ENGINE_REVISION, index: null,
    config: { applicability: 'not-used', reason: 'Direct file map/source selection does not consult the workspace graph or resolver configuration.' },
    source: options.snapshot, freshness, freshnessBoundary: 'source-rechecked-after-selection',
    completeness: options.complete ? 'complete' : 'partial', basis: 'source', selectionReason: options.selectionReason,
    omissions, limitations: ['Completeness covers only the declared file selection policy and parser capabilities.', 'Freshness is checked at read time; this is not an atomic workspace snapshot or a dependency freshness guarantee.', `Engine revision is hash-bound to runtime package and compiler dependencies (${FULL_ENGINE_REVISION}).`],
  };
}

export function formatRetrievalEvidence(evidence: RetrievalEvidence): string {
  const parts = [
    `Retrieval: status=${evidence.freshness}; completeness=${evidence.completeness}; policy=${evidence.policy}`,
  ];
  if (evidence.source?.sha256) {
    parts.push(`sha256=${evidence.source.sha256.slice(0, 12)}`);
  }
  if (evidence.omissions && evidence.omissions.length > 0) {
    const uniqueCodes = Array.from(new Set(evidence.omissions.map((o) => o.code)));
    parts.push(`omissions=${uniqueCodes.join(',')}`);
  }
  return parts.join(' | ');
}

/** Until a dependency manifest is captured, primary-file freshness cannot verify derived results. */
export async function derivedRetrievalEvidence(options: Parameters<typeof sourceRetrievalEvidence>[0] & {
  dependencies?: InputDependency[];
  configFingerprint?: string;
}): Promise<RetrievalEvidence> {
  const source = await sourceRetrievalEvidence({ ...options, complete: false });
  const omissions = [...source.omissions];

  let dependenciesStatus: 'unverified' | 'current' | 'stale' = 'unverified';
  let dependenciesReason = 'Imported types, resolver inputs and secondary analysis reads are not captured in a single dependency snapshot.';
  let overallFreshness: 'current' | 'stale' | 'unavailable' = source.freshness === 'stale' ? 'stale' : 'unavailable';

  if (options.dependencies && options.dependencies.length > 0) {
    let staleCount = 0;
    for (const dep of options.dependencies) {
      try {
        if (!existsSync(dep.path)) {
          staleCount++;
        } else {
          const currentContent = await readSourceFile(dep.path);
          const currentHash = createHash('sha256').update(currentContent).digest('hex');
          if (currentHash !== dep.hash) {
            staleCount++;
          }
        }
      } catch {
        staleCount++;
      }
    }

    if (staleCount > 0) {
      dependenciesStatus = 'stale';
      dependenciesReason = `One or more secondary dependencies changed on disk (${staleCount}/${options.dependencies.length}).`;
      overallFreshness = 'stale';
      omissions.push({ code: 'DEPENDENCY_CHANGED', reason: dependenciesReason });
    } else {
      dependenciesStatus = 'current';
      dependenciesReason = `All ${options.dependencies.length} tracked dependencies verified against disk.`;
      overallFreshness = source.freshness === 'current' ? 'current' : source.freshness;
    }
  } else {
    omissions.push({ code: 'DERIVED_INPUTS_UNVERIFIED', reason: 'Primary source identity does not verify all inputs used by derived analysis.' });
  }

  const configFingerprint = options.configFingerprint;
  const config = configFingerprint
    ? {
        applicability: 'indexed' as const,
        fingerprint: configFingerprint,
        reason: 'Effective resolver and compiler configuration hash-bound to this derived retrieval.',
      }
    : {
        applicability: 'unverified' as const,
        reason: 'Resolver/framework configuration used by derived analysis is not captured in a hash-bound manifest.',
      };

  return {
    ...source,
    basis: 'derived',
    sourceFreshness: source.freshness,
    freshness: overallFreshness,
    config,
    dependencies: {
      status: dependenciesStatus,
      reason: dependenciesReason,
      count: options.dependencies?.length,
    },
    omissions,
    limitations: [...source.limitations, 'Retrieval identity binds the query and primary source only; it is not a reproducibility identity for the derived dependency closure.'],
  };
}

export function filesystemAuditRetrievalEvidence(options: {
  workspace: string;
  scope?: string;
  policy?: string;
  query: Record<string, unknown>;
  selectionReason: string;
}): RetrievalEvidence {
  const policy = options.policy ?? 'filesystem-audit-v1';
  const queryId = hashRetrievalIdentity({ workspace: options.workspace, scope: options.scope ?? options.workspace, policy, query: options.query });
  return {
    version: 1,
    workspace: options.workspace,
    scope: options.scope ?? options.workspace,
    queryId,
    retrievalId: createHash('sha256').update(canonical({ queryId, engineRevision: FULL_ENGINE_REVISION })).digest('hex'),
    policy,
    engineRevision: FULL_ENGINE_REVISION,
    index: null,
    config: {
      applicability: 'not-used',
      reason: 'Direct filesystem audit inspects source files directly without consulting the SQLite graph index.',
    },
    freshness: 'unavailable',
    freshnessBoundary: 'not-verified',
    completeness: 'partial',
    basis: 'derived',
    dependencies: {
      status: 'unverified',
      reason: 'Direct filesystem audit reads files on-demand; no atomic dependency snapshot is captured.',
    },
    selectionReason: options.selectionReason,
    omissions: [{
      code: 'DIRECT_FILESYSTEM_SCAN',
      reason: 'Audit was performed directly via filesystem/AST inspection rather than SQLite index snapshot.',
    }],
    limitations: [
      'Completeness is limited by directory traversal and parser capabilities.',
      'Analysis reads files directly from disk without atomic workspace locking.',
      `Engine revision is hash-bound to runtime package and compiler dependencies (${FULL_ENGINE_REVISION}).`,
    ],
  };
}
