import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { observeRetrievalIndex } from '../../src/engine/index-retrieval-evidence';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import {
  closeWorkspaceDatabase, getWorkspaceDatabase, initSchema, openReadonlyIndex, SCHEMA_USER_VERSION,
} from '../../src/engine/storage/schema';

test('future schema is rejected without modifying the database, journal or data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-future-index-'));
  const path = join(root, '.strata', 'graph.db');
  try {
    await mkdir(join(root, '.strata'));
    const db = new Database(path);
    const futureVersion = SCHEMA_USER_VERSION + 1;
    try {
      db.run(`CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserve'); PRAGMA user_version = ${futureVersion};`);
      expect(() => initSchema(db)).toThrow('INDEX_SCHEMA_TOO_NEW');
      await expect(syncWorkspace(root, undefined, db, { rebuild: true })).rejects.toThrow('INDEX_SCHEMA_TOO_NEW');
    } finally { db.close(); }
    const before = await readFile(path);
    expect(() => getWorkspaceDatabase(root)).toThrow('INDEX_SCHEMA_TOO_NEW');
    expect(() => openReadonlyIndex(path)).toThrow('INDEX_SCHEMA_TOO_NEW');
    expect(observeRetrievalIndex(root)).toBeNull();
    expect(await readFile(path)).toEqual(before);
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: futureVersion });
      expect(check.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(check.query('SELECT * FROM sentinel').all()).toEqual([{ value: 'preserve' }]);
    } finally { check.close(); }
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('older compatible schema migrates and a failed DDL rolls back', () => {
  const legacy = new Database(':memory:');
  const broken = new Database(':memory:');
  try {
    legacy.run("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('keep', 'yes'); PRAGMA user_version = 1;");
    initSchema(legacy);
    expect(legacy.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_USER_VERSION });
    expect(legacy.query("SELECT value FROM meta WHERE key='keep'").get()).toEqual({ value: 'yes' });

    broken.run('CREATE TABLE components(id INTEGER); PRAGMA user_version = 1;');
    expect(() => initSchema(broken)).toThrow();
    expect(broken.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(broken.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
      .toEqual([{ name: 'components' }]);
  } finally {
    legacy.close();
    broken.close();
  }
});
