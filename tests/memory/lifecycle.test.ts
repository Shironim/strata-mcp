import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseCache } from '@vue/compiler-sfc';
import { parseSfc } from '../../src/engine/splitter';
import { getProjectEcosystem } from '../../src/engine/contract';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';

const roots: string[] = [];
function root() {
  const r = mkdtempSync('/tmp/strata-lifecycle-'); roots.push(r);
  writeFileSync(join(r, 'package.json'), '{"dependencies":{"vue":"3"}}');
  mkdirSync(join(r, '.strata'), { recursive: true });
  return r;
}
afterEach(() => { closeAllDatabases(); parseCache.clear(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

test('parsing repeated revisions does not retain source or AST in the compiler cache', () => {
  for (let i = 0; i < 600; i++) parseSfc(`<template><div>${i}</div></template>`, 'same.vue');
  expect(parseCache.size).toBe(0);
});

test('project ecosystem follows manifest changes instead of retaining stale cache', () => {
  const r = root(); expect(getProjectEcosystem(r).hasVue).toBe(true);
  const time = new Date(1700000000000);
  utimesSync(join(r, 'package.json'), time, time);
  expect(getProjectEcosystem(r).hasVue).toBe(true);
  writeFileSync(join(r, 'package.json'), '{"dependencies":{"react":"19"}}');
  utimesSync(join(r, 'package.json'), time, time);
  expect(getProjectEcosystem(r)).toMatchObject({ hasVue: false, hasReact: true, hasAstro: false });
});

test('project ecosystem follows framework config creation, replacement and deletion', () => {
  const r = root();
  expect(getProjectEcosystem(r).hasNext).toBe(false);
  writeFileSync(join(r, 'next.config.mjs'), 'export default {}');
  expect(getProjectEcosystem(r).frameworks.next?.configFile).toBe('next.config.mjs');
  writeFileSync(join(r, 'next.config.js'), 'module.exports = {}');
  expect(getProjectEcosystem(r).frameworks.next?.configFile).toBe('next.config.js');
  unlinkSync(join(r, 'next.config.js'));
  unlinkSync(join(r, 'next.config.mjs'));
  expect(getProjectEcosystem(r).hasNext).toBe(false);
});

test('same-size edits with identical timestamps replace stale indexed contracts', async () => {
  const r = root(); const file = join(r, 'App.vue');
  const a = '<template><slot name="old" /></template>';
  const b = '<template><slot name="new" /></template>';
  const time = new Date(1700000000000);
  writeFileSync(file, a); utimesSync(file, time, time);
  await syncWorkspace(r);
  writeFileSync(file, b); utimesSync(file, time, time);
  await syncWorkspace(r);
  const db = getWorkspaceDatabase(r);
  const row = db.query('SELECT contract_json FROM components').get() as {contract_json: string};
  expect(JSON.parse(row.contract_json).slots).toEqual(['new']);
});

test('empty route scans remove stale routes even without a file delta', async () => {
  const r = root(); writeFileSync(join(r, 'App.vue'), '<template><div /></template>');
  await syncWorkspace(r);
  const db = getWorkspaceDatabase(r);
  // A legacy route manifest can refer to a source that still exists.
  db.run("INSERT INTO routes(url_path,file_id,type) SELECT '/obsolete',id,'page' FROM files");
  await syncWorkspace(r);
  expect(db.query('SELECT url_path FROM routes').all()).toEqual([]);
});

test('malformed replacements remove stale derived data and report a parse error', async () => {
  const r = root(); const file = join(r, 'App.vue');
  writeFileSync(file, '<template><slot name="old" /></template>'); await syncWorkspace(r);
  writeFileSync(file, '<template><div></template>');
  await expect(syncWorkspace(r)).rejects.toThrow();
  const db = getWorkspaceDatabase(r);
  expect(db.query('SELECT * FROM components').all()).toEqual([]);
});

test('scoped sync preserves incoming edges from outside callers', async () => {
  const r = root();
  mkdirSync(join(r, 'src/components'), { recursive: true });
  mkdirSync(join(r, 'src/pages'), { recursive: true });
  const pageFile = join(r, 'src/pages/Home.vue');
  const compFile = join(r, 'src/components/Child.vue');

  writeFileSync(compFile, '<template><div class="child">v1</div></template>');
  writeFileSync(pageFile, '<script setup>\nimport Child from "../components/Child.vue";\n</script>\n<template><Child /></template>');

  await syncWorkspace(r);
  const db = getWorkspaceDatabase(r);
  const pageRow = db.query('SELECT id FROM files WHERE path = ?').get(pageFile) as { id: number } | null;
  const compRow = db.query('SELECT id FROM files WHERE path = ?').get(compFile) as { id: number } | null;
  expect(pageRow).not.toBeNull();
  expect(compRow).not.toBeNull();

  db.run("INSERT OR IGNORE INTO edges(parent_file_id, child_file_id, import_type, is_rendered) VALUES (?, ?, 'static', 1)", [pageRow!.id, compRow!.id]);
  const edgeCountBefore = (db.query('SELECT count(*) as c FROM edges').get() as { c: number }).c;
  expect(edgeCountBefore).toBeGreaterThan(0);

  // Now update Child.vue and perform scoped sync only on 'src/components'
  writeFileSync(compFile, '<template><div class="child">v2</div></template>');
  await syncWorkspace(r, 'src/components');

  const edgeCountAfter = (db.query('SELECT count(*) as c FROM edges').get() as { c: number }).c;
  expect(edgeCountAfter).toBe(edgeCountBefore);
});

test('corrupted database file throws explicit actionable error without silent deletion', () => {
  const r = root();
  const dbPath = join(r, '.strata', 'graph.db');
  writeFileSync(dbPath, 'NOT A VALID SQLITE DATABASE FILE - CORRUPTED BYTES');

  expect(() => getWorkspaceDatabase(r, { enableWatcher: false })).toThrow(/SQLite database may be corrupt/);
  // Verify that the corrupt file is preserved for manual recovery and not silently wiped
  const content = Bun.file(dbPath).text();
  expect(content).resolves.toContain('CORRUPTED BYTES');
});

test('concurrent sync publication detects generation mismatch and aborts atomically', async () => {
  const r = root();
  writeFileSync(join(r, 'App.vue'), '<template><div>App v1</div></template>');
  const db = getWorkspaceDatabase(r, { enableWatcher: false });
  await syncWorkspace(r);

  const initialGeneration = (db.query("SELECT value FROM meta WHERE key = 'sync_generation'").get() as { value: string }).value;
  expect(Number(initialGeneration)).toBeGreaterThan(0);

  // Simulate a concurrent sync writer advancing generation while second sync is in flight
  writeFileSync(join(r, 'App.vue'), '<template><div>App v2</div></template>');

  const { stagedSync } = await import('../../src/engine/storage/staged-sync');
  // Mutate meta mid-flight right before transaction commit by overriding query/run
  const originalRun = db.run.bind(db);
  let injected = false;
  db.run = (sql: string, ...args: any[]) => {
    if (sql.includes('CREATE TEMP TABLE sync_files') && !injected) {
      injected = true;
      originalRun("UPDATE meta SET value = '9999' WHERE key = 'sync_generation'");
    }
    return originalRun(sql, ...args);
  };

  try {
    await expect(stagedSync(r, undefined, db)).rejects.toThrow(/WORKSPACE_CHANGED:/);
    expect(injected).toBe(true);
  } finally {
    db.run = originalRun;
  }
});
