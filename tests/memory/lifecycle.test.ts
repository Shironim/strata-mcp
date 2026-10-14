import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCache } from '@vue/compiler-sfc';
import { parseSfc } from '../../src/engine/splitter';
import { getProjectEcosystem } from '../../src/engine/contract';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { WorkspaceWatcher, startWorkspaceWatcher } from '../../src/engine/watcher';

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
  writeFileSync(join(r, 'package.json'), '{"dependencies":{"react":"19"}}');
  expect(getProjectEcosystem(r)).toEqual({ hasVue: false, hasReact: true, hasAstro: false });
});

test('closed watchers release their dirty queue and can be replaced in the registry', () => {
  const r = root(); const db = getWorkspaceDatabase(r, { enableWatcher: false });
  const watcher = startWorkspaceWatcher(r, db, { debounceMs: 60000 })!;
  expect(watcher).not.toBeNull();
  (watcher as any).handleFsEvent('transient.ts'); watcher.close();
  expect((watcher as any).pendingDirtyPaths.size).toBe(0);
  const next = startWorkspaceWatcher(r, db);
  expect(next).not.toBe(watcher);
  next?.close();
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
