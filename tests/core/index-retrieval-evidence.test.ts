import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { indexedRetrievalEvidence, observeRetrievalIndex } from '../../src/engine/index-retrieval-evidence';

test('index observation binds generation/config/manifest without claiming disk freshness', async () => {
  const root = await mkdtemp('/tmp/strata-index-evidence-');
  let db: Database | undefined;
  try {
    expect(observeRetrievalIndex(root)).toBeNull();
    await mkdir(join(root, '.strata'));
    db = new Database(join(root, '.strata/graph.db'), { create: true });
    db.run('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE files(path TEXT,content_hash TEXT)');
    for (const [key, value] of [['sync_generation', '1'], ['config_fingerprint', 'config-a'], ['cache_version', 'fixture-v1']]) db.run('INSERT INTO meta VALUES (?,?)', [key!, value!]);
    db.run('INSERT INTO files VALUES (?,?)', [join(root, 'Child.vue'), 'a'.repeat(64)]);
    const before = observeRetrievalIndex(root);
    const options = { workspace: root, scope: root, policy: 'fixture-v1', query: { depth: 1 }, before, selectionReason: 'fixture' };
    const stable = indexedRetrievalEvidence(options);
    expect(stable.index?.consistency).toBe('observed-stable');
    expect(stable.freshness).toBe('unavailable');
    expect(stable.completeness).toBe('partial');
    db.run("UPDATE meta SET value='2' WHERE key='sync_generation'");
    expect(indexedRetrievalEvidence(options).freshness).toBe('stale');
    db.run("INSERT INTO meta VALUES ('index_invalid','1')");
    expect(observeRetrievalIndex(root)).toBeNull();
    expect(indexedRetrievalEvidence(options).index?.consistency).toBe('unavailable');
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
