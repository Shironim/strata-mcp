import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRenderBoundary } from '../../src/engine/contract';
import { extractSvelteContract } from '../../src/engine/parsers/contract-svelte';
import type { SourceSnapshot } from '../../src/types';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { STRATA_VERSION } from '../../src/version';

test('boundary contract accepts detected framework identifiers without losing existing behavior', () => {
  expect(extractRenderBoundary('/app/page.tsx', "'use client';", 'next').boundary).toBe('client-component');
  expect(extractRenderBoundary('/pages/Profile.client.vue', '<template/>', 'nuxt').boundary).toBe('client-only');
  expect(extractRenderBoundary('/Card.svelte', '<div/>', 'svelte').boundary).toBe('unknown');
});

test('Svelte slot metadata distinguishes payloads and parameterized snippets from empty slots', async () => {
  const legacy = await extractSvelteContract('Legacy.svelte', '<slot name="item" value={item}/><slot/>');
  expect(legacy.slotDetails).toEqual([
    { name: 'item', isScoped: true, bindings: ['value'] },
    { name: 'default', isScoped: false },
  ]);
  const snippets = await extractSvelteContract('Snippets.svelte', '{#snippet row(item)}<span>{item}</span>{/snippet}{#snippet footer()}<span>footer</span>{/snippet}');
  expect(snippets.slotDetails?.find(slot => slot.name === 'row')).toMatchObject({ isScoped: true });
  expect(snippets.slotDetails?.find(slot => slot.name === 'footer')).toMatchObject({ isScoped: false });
});

test('sync invalidates the Tier 4 fingerprint at the same package version and removes legacy enrichments', async () => {
  const root = await mkdtemp('/tmp/strata-contract-typing-cache-');
  try {
    const manifest = '{"dependencies":{"vue":"^3.4.21"}}';
    const manifestPath = join(root, 'package.json');
    const entryPath = join(root, 'App.vue');
    const call = 'defineProps<{ modelValue: string }>()';
    const source = `<script setup lang="ts">\nconst props = ${call};\nconst emit = defineEmits<{(e: 'update:modelValue', value: string): void}>();\n</script><template><div/></template>`;
    await writeFile(manifestPath, manifest);
    await writeFile(entryPath, source);
    const db = getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    await syncWorkspace(root);
    const priorFingerprint = createHash('sha256').update(STRATA_VERSION).update('\0structural-contract-tier4-v1')
      .update(manifestPath).update('\0').update(createHash('sha256').update(manifest).digest('hex')).digest('hex');
    db.run("UPDATE meta SET value=? WHERE key='config_fingerprint'", [priorFingerprint]);
    db.run("UPDATE components SET contract_json='{\"inferredProps\":[{\"propName\":\"legacy\"}],\"globalSymbols\":[{\"name\":\"route\"}]}'");
    const stats = await syncWorkspace(root);
    expect(stats.cacheHit).toBe(false);
    const row = db.query('SELECT contract_json FROM components').get() as { contract_json: string };
    const contract = JSON.parse(row.contract_json);
    expect(contract).not.toHaveProperty('inferredProps');
    expect(contract).not.toHaveProperty('globalSymbols');
    expect(contract.props.some((prop: { name: string }) => prop.name === 'modelValue')).toBe(true);
    expect((await syncWorkspace(root)).cacheHit).toBe(true);
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});
