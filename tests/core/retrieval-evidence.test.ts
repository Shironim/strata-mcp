import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readSourceSnapshot } from '../../src/engine/source-file';
import { sourceRetrievalEvidence, derivedRetrievalEvidence } from '../../src/engine/retrieval-evidence';

test('source evidence separates freshness/completeness and binds retrieval identity to content', async () => {
  const root = await mkdtemp('/tmp/strata-evidence-');
  try {
    const file = join(root, 'Page.vue');
    await writeFile(file, '<template><h1>🙂</h1></template>');
    const { snapshot } = await readSourceSnapshot(file);
    const options = { workspace: root, snapshot, policy: 'fixture-v1', query: { limit: 1, view: 'map' }, complete: false, selectionReason: 'fixture selection' };
    const current = await sourceRetrievalEvidence(options);
    const reordered = await sourceRetrievalEvidence({ ...options, query: { view: 'map', limit: 1 } });
    expect(current.freshness).toBe('current');
    expect(current.completeness).toBe('partial');
    expect(reordered.queryId).toBe(current.queryId);
    expect(reordered.retrievalId).toBe(current.retrievalId);
    await writeFile(file, '<template><h2>new</h2></template>');
    const stale = await sourceRetrievalEvidence(options);
    expect(stale.freshness).toBe('stale');
    expect(stale.omissions.map(o => o.code)).toContain('SOURCE_CHANGED');
    const fresh = await sourceRetrievalEvidence({ ...options, snapshot: (await readSourceSnapshot(file)).snapshot, complete: true });
    expect(fresh.queryId).toBe(current.queryId);
    expect(fresh.retrievalId).not.toBe(current.retrievalId);
    expect(fresh.completeness).toBe('complete');
    await unlink(file);
    expect((await sourceRetrievalEvidence(options)).freshness).toBe('unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('derived freshness remains unavailable when only the primary source is verified', async () => {
  const root = await mkdtemp('/tmp/strata-derived-evidence-');
  try {
    const file = join(root, 'Child.vue');
    await writeFile(file, '<template><div /></template>');
    const { snapshot } = await readSourceSnapshot(file);
    const options = { workspace: root, snapshot, policy: 'contract-v1', query: {}, complete: true, selectionReason: 'contract' };
    const result = await derivedRetrievalEvidence(options);
    expect(result.basis).toBe('derived');
    expect(result.sourceFreshness).toBe('current');
    expect(result.freshness).toBe('unavailable');
    expect(result.completeness).toBe('partial');
    expect(result.config.applicability).toBe('unverified');
    expect(result.dependencies?.status).toBe('unverified');
    expect(result.omissions.map(o => o.code)).toContain('DERIVED_INPUTS_UNVERIFIED');
    await writeFile(file, '<template><span /></template>');
    expect((await derivedRetrievalEvidence(options)).freshness).toBe('stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});
