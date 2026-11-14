import { getWorkspaceDatabase } from './schema';
import { syncWorkspace } from './delta-sync';
import type { SyncStats } from '../../types';

export async function prepareStateQuery(root: string, skipSync = false) {
  const db = getWorkspaceDatabase(root);
  let sync: Pick<SyncStats, 'cacheHit' | 'syncGeneration' | 'configFingerprint'>;
  if (skipSync) {
    const rows = db.query("SELECT key, value FROM meta WHERE key IN ('sync_generation', 'config_fingerprint')").all() as Array<{ key: string; value: string }>;
    const meta = new Map(rows.map(row => [row.key, row.value]));
    sync = { cacheHit: true, syncGeneration: Number(meta.get('sync_generation') || 0), configFingerprint: meta.get('config_fingerprint') || '' };
  } else sync = await syncWorkspace(root);
  return { db, sync };
}
