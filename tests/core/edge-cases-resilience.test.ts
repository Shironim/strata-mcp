import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractImports } from '../../src/engine/graph/path-helpers';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { queryUnusedComponentsFromDb } from '../../src/engine/storage/blast-radius';
import { WorkspaceWatcher } from '../../src/engine/watcher';

describe('Edge Cases & Unhappy Path Resilience Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    closeAllDatabases();
    tempDir = mkdtempSync('/tmp/strata-edge-cases-');
    writeFileSync(join(tempDir, 'package.json'), '{"dependencies":{"vue":"3"}}');
    mkdirSync(join(tempDir, '.strata'), { recursive: true });
  });

  afterEach(() => {
    closeAllDatabases();
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore on windows/busy locks
      }
    }
  });

  describe('Edge Case 1: Watcher Degradation & Fallback State', () => {
    it('provides observable watcher status and marks degradation on failure', () => {
      const db = getWorkspaceDatabase(tempDir, { enableWatcher: false });
      let capturedError: Error | null = null;
      const watcher = new WorkspaceWatcher(tempDir, db, {
        debounceMs: 50,
        onError: (err) => { capturedError = err; },
      });

      expect(typeof watcher.getStatus).toBe('function');
      const initialStatus = watcher.getStatus();
      expect(initialStatus.active).toBe(false);
      expect(initialStatus.degraded).toBe(false);

      // Simulate an OS inotify ENOSPC failure during start
      (watcher as any).handleWatchError(new Error('ENOSPC: System limit for number of file watchers reached'));
      
      const degradedStatus = watcher.getStatus();
      expect(degradedStatus.degraded).toBe(true);
      expect(degradedStatus.mode).toBe('degraded');
      expect(watcher.isDegraded()).toBe(true);
      expect(capturedError).not.toBeNull();
      expect(capturedError?.message).toContain('ENOSPC');

      watcher.close();
      expect(watcher.getStatus().mode).toBe('closed');
    });

    it('gracefully handles polling fallback when native watcher fails', async () => {
      const db = getWorkspaceDatabase(tempDir, { enableWatcher: false });
      let syncNotified = false;
      const watcher = new WorkspaceWatcher(tempDir, db, {
        debounceMs: 50,
        fallbackPolling: true,
        pollingIntervalMs: 100,
        onSyncComplete: () => { syncNotified = true; },
      });

      // Trigger fallback to polling
      (watcher as any).enablePollingFallback();
      expect(watcher.getStatus().mode).toBe('polling');
      expect(watcher.getStatus().active).toBe(true);

      // Create a new component file
      const compPath = join(tempDir, 'PolledComponent.vue');
      writeFileSync(compPath, '<template><div>Polled</div></template>');

      // Wait for poll tick
      await new Promise((r) => setTimeout(r, 250));

      const rows = db.query('SELECT path FROM files WHERE path = ?').all(compPath);
      expect(rows.length).toBe(1);

      watcher.close();
      expect(watcher.getStatus().active).toBe(false);
    });
  });

  describe('Edge Case 2: Dynamic Imports & Indirection Resolution', () => {
    it('extracts arrow function dynamic imports without defineAsyncComponent wrapper', () => {
      const code = `
        const LazyView = () => import('./views/AboutView.vue');
        export const routes = [
          { path: '/profile', component: () => import('./views/ProfileView.vue') }
        ];
      `;
      const imports = extractImports(code, join(tempDir, 'router.ts'));
      const sources = imports.map((i) => i.source);

      expect(sources).toContain('./views/AboutView.vue');
      expect(sources).toContain('./views/ProfileView.vue');
      const lazyView = imports.find((i) => i.source === './views/AboutView.vue');
      expect(lazyView?.isDynamic).toBe(true);
      expect(lazyView?.name).toBe('LazyView');

      const profileView = imports.find((i) => i.source === './views/ProfileView.vue');
      expect(profileView?.isDynamic).toBe(true);
      expect(profileView?.name).toBe('ProfileView');
    });

    it('extracts await dynamic imports', () => {
      const code = `
        async function openModal() {
          const { Modal } = await import('./components/ConfirmModal.vue');
          return Modal;
        }
      `;
      const imports = extractImports(code, join(tempDir, 'handler.ts'));
      const modal = imports.find((i) => i.source === './components/ConfirmModal.vue');

      expect(modal).toBeDefined();
      expect(modal?.isDynamic).toBe(true);
    });

    it('resolves dynamic template literals with variables and links candidate directory components', async () => {
      mkdirSync(join(tempDir, 'widgets'), { recursive: true });
      writeFileSync(join(tempDir, 'widgets/ChartWidget.vue'), '<template><div>Chart</div></template>');
      writeFileSync(join(tempDir, 'widgets/TableWidget.vue'), '<template><div>Table</div></template>');

      // Parent component dynamically imports widgets via template string
      writeFileSync(
        join(tempDir, 'Dashboard.vue'),
        `<script setup>
        const loadWidget = (name) => import(\`./widgets/\${name}Widget.vue\`);
        </script>
        <template><div>Dashboard</div></template>`
      );

      await syncWorkspace(tempDir);
      const db = getWorkspaceDatabase(tempDir);

      // Verify edges were created so widgets are NOT treated as dead/orphan components
      const unused = queryUnusedComponentsFromDb(db);
      const unusedNames = unused.map((u) => u.name);

      expect(unusedNames).not.toContain('ChartWidget');
      expect(unusedNames).not.toContain('TableWidget');
    });
  });

  describe('Edge Case 3: SQLite Concurrency & Non-destructive Busy Handling', () => {
    it('does NOT wipe database files when encountering SQLITE_BUSY error', async () => {
      const compPath = join(tempDir, 'ExistingButton.vue');
      writeFileSync(compPath, '<template><button>Click</button></template>');

      // Initial successful sync
      await syncWorkspace(tempDir);
      const db = getWorkspaceDatabase(tempDir);
      const countBefore = (db.query('SELECT count(*) as count FROM files').get() as { count: number }).count;
      expect(countBefore).toBeGreaterThan(0);

      const { stagedSync } = await import('../../src/engine/storage/staged-sync');

      // Create a mock DB that throws SQLITE_BUSY on transaction
      const mockBusyDb = {
        ...db,
        prepare: (sql: string) => db.prepare(sql),
        run: (sql: string, ...args: any[]) => db.run(sql, ...args),
        query: (sql: string) => db.query(sql),
        transaction: () => {
          const err = new Error('SQLITE_BUSY: database is locked');
          (err as any).code = 'SQLITE_BUSY';
          throw err;
        },
      } as any;

      // stagedSync should reject with SQLITE_BUSY
      await expect(stagedSync(tempDir, undefined, mockBusyDb)).rejects.toThrow(/SQLITE_BUSY/);

      // Verify that database was NOT wiped by catch block
      const countAfter = (db.query('SELECT count(*) as count FROM files').get() as { count: number }).count;
      expect(countAfter).toBe(countBefore);
      const metaInvalid = db.query("SELECT value FROM meta WHERE key = 'index_invalid'").get() as { value: string } | null;
      expect(metaInvalid?.value ?? '').not.toBe('1');
    });

    it('retries on SQLITE_BUSY during syncWorkspace', async () => {
      writeFileSync(join(tempDir, 'Card.vue'), '<template><div>Card</div></template>');
      
      let attempts = 0;
      const db = getWorkspaceDatabase(tempDir);
      const originalPrepare = db.prepare.bind(db);

      // Flaky lock simulation: fails once with SQLITE_BUSY then succeeds
      db.prepare = (sql: string) => {
        if (sql.includes('sync_files') && attempts === 0) {
          attempts++;
          const busyErr = new Error('SQLITE_BUSY: database is locked');
          (busyErr as any).code = 'SQLITE_BUSY';
          throw busyErr;
        }
        return originalPrepare(sql);
      };

      try {
        const stats = await syncWorkspace(tempDir, undefined, db);
        expect(stats.total).toBeGreaterThanOrEqual(1);
        expect(attempts).toBe(1);
      } finally {
        db.prepare = originalPrepare;
      }
    });
  });
});
