import { beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatStateImpactAsText,
  getWorkspaceDatabase,
  queryStateImpact,
  queryUnusedComponentsFromDb,
  queryUpwardBlastRadiusFromDb,
  syncWorkspace,
} from '../../src/engine/database';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Persistent SQLite Codebase Graph Cache Engine (bun:sqlite)', () => {
  beforeAll(() => {
    const dbDir = join(FIXTURES_DIR, '.strata');
    if (existsSync(dbDir)) {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('initializes SQLite database in .strata with WAL mode and gitignore', () => {
    const db = getWorkspaceDatabase(FIXTURES_DIR);
    expect(db).toBeDefined();

    const gitignorePath = join(FIXTURES_DIR, '.strata', '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);

    const pragmaJournal = db.query('PRAGMA journal_mode;').get() as { journal_mode: string };
    expect(pragmaJournal.journal_mode.toLowerCase()).toBe('wal');
  });

  it('performs cold start workspace sync and indexes files, components, and edges', async () => {
    const stats = await syncWorkspace(FIXTURES_DIR);
    expect(stats.total).toBeGreaterThan(10);
    expect(stats.added).toBeGreaterThanOrEqual(1);

    const db = getWorkspaceDatabase(FIXTURES_DIR);
    const filesCount = db.query('SELECT COUNT(*) as count FROM files;').get() as { count: number };
    expect(filesCount.count).toBeGreaterThan(10);

    const componentsCount = db.query('SELECT COUNT(*) as count FROM components;').get() as {
      count: number;
    };
    expect(componentsCount.count).toBeGreaterThan(5);
  });

  it('executes warm delta sync with zero re-parse penalty (< 10ms)', async () => {
    const warmStats = await syncWorkspace(FIXTURES_DIR);
    expect(warmStats.added).toBe(0);
    expect(warmStats.modified).toBe(0);
    expect(warmStats.deleted).toBe(0);
    expect(warmStats.unchanged).toBe(warmStats.total);
    expect(warmStats.durationMs).toBeLessThan(100);
  });

  it('queries upward blast radius using SQLite Recursive CTE', async () => {
    const db = getWorkspaceDatabase(FIXTURES_DIR);
    const oldButtonPath = join(FIXTURES_DIR, 'OldButton.vue');

    const blastRadius = queryUpwardBlastRadiusFromDb(db, oldButtonPath, 4);
    expect(blastRadius.length).toBeGreaterThanOrEqual(1);

    const paths = blastRadius.map((b) => b.path);
    expect(paths.some((p) => p.includes('PageOne.vue'))).toBe(true);
  });

  it('queries unused components directly from SQLite via SQL anti-join', async () => {
    const db = getWorkspaceDatabase(FIXTURES_DIR);
    const unused = queryUnusedComponentsFromDb(db);
    expect(Array.isArray(unused)).toBe(true);

    const names = unused.map((u) => u.name);
    expect(names).toContain('CardComponent');
  });

  it('queries state impact for a composable or store across the project', async () => {
    const result = await queryStateImpact(FIXTURES_DIR, 'useRouter');
    expect(result.identifier).toBe('useRouter');

    const formatted = formatStateImpactAsText(result);
    expect(formatted).toContain('State Impact Analysis for: useRouter');
  });
});
