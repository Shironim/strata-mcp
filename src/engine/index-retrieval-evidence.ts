import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RetrievalEvidence } from '../types';
import { FULL_ENGINE_REVISION } from '../version';
import { hashRetrievalIdentity } from './retrieval-evidence';

export interface IndexObservation {
  generation: string;
  configFingerprint: string;
  cacheVersion: string;
  manifestHash: string;
}

/** Read-only identity observation; does not initialize, sync or validate disk source. */
export function observeRetrievalIndex(workspace: string): IndexObservation | null {
  let db: Database | undefined;
  try {
    db = new Database(join(workspace, '.strata', 'graph.db'), { readonly: true });
    const connection = db;
    return connection.transaction(() => {
      const meta = (key: string) => (connection.query('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | null)?.value ?? '';
      if (meta('index_invalid') === '1') return null;
      const generation = meta('sync_generation');
      const configFingerprint = meta('config_fingerprint');
      const cacheVersion = meta('cache_version');
      if (!generation || !configFingerprint || !cacheVersion) return null;
      const hash = createHash('sha256');
      for (const row of connection.query('SELECT path, content_hash FROM files ORDER BY path').iterate() as Iterable<{path: string; content_hash: string | null}>) {
        if (!row.content_hash) return null;
        hash.update(JSON.stringify([row.path, row.content_hash])).update('\n');
      }
      return { generation, configFingerprint, cacheVersion, manifestHash: hash.digest('hex') };
    })();
  } catch {
    return null;
  } finally { db?.close(); }
}

export function indexedRetrievalEvidence(options: {
  workspace: string; scope: string; policy: string; query: Record<string, unknown>;
  before: IndexObservation | null; selectionReason: string;
}): RetrievalEvidence {
  const after = observeRetrievalIndex(options.workspace);
  const stable = Boolean(options.before && after && JSON.stringify(options.before) === JSON.stringify(after));
  const changed = Boolean(options.before && after && !stable);
  const queryId = hashRetrievalIdentity({ workspace: options.workspace, scope: options.scope, policy: options.policy, query: options.query });
  return {
    version: 1, workspace: options.workspace, scope: options.scope, policy: options.policy, queryId,
    retrievalId: createHash('sha256').update(JSON.stringify({ queryId, index: options.before, engineRevision: FULL_ENGINE_REVISION })).digest('hex'),
    engineRevision: FULL_ENGINE_REVISION,
    index: options.before ? { ...options.before, consistency: stable ? 'observed-stable' : changed ? 'changed' : 'unavailable' } : null,
    config: { applicability: options.before ? 'indexed' : 'unverified', fingerprint: options.before?.configFingerprint,
      reason: 'Fingerprint is an index observation, not proof that the analysis used that configuration or a fresh hash of all resolver inputs on disk.' },
    freshness: changed ? 'stale' : 'unavailable', freshnessBoundary: 'index-rechecked-after-analysis',
    completeness: 'partial', basis: 'derived',
    dependencies: { status: 'unverified', reason: 'Stable index observations do not prove disk freshness or all analysis reads belong to that index snapshot.' },
    selectionReason: options.selectionReason,
    omissions: [{ code: changed ? 'INDEX_CHANGED' : stable ? 'DISK_FRESHNESS_UNVERIFIED' : 'INDEX_OBSERVATION_UNAVAILABLE',
      reason: changed ? 'Index identity changed during analysis; repeat retrieval.' : stable ? 'Index identity was stable, but source/dependency reads are not atomically bound to it.' : 'Index identity could not be observed consistently before and after analysis.' }],
    limitations: ['Completeness is limited by graph discovery, traversal bounds and parser capabilities.', 'Index identity is observed around analysis; it is not proof that every analysis branch consumed this index.', 'Index manifest hashes indexed file identities only; it does not validate current disk bytes.', `Engine revision is hash-bound to runtime package and compiler dependencies (${FULL_ENGINE_REVISION}).`],
  };
}
