import type { Database } from 'bun:sqlite';
import type { SyncStats } from '../../types';
import { canonicalizePath } from '../path-resolver';
import { assertCompatibleSchema, getWorkspaceDatabase, resolveIndexedWorkspaceRoot } from './schema';
import { stagedSync } from './staged-sync';

export { batchParser } from './index-payload';
export type { ParsedFilePayload, ParsedWorkspaceBatch } from './index-payload';

/**
 * Synchronizes the workspace disk state with SQLite using staged sync.
 */
export async function syncWorkspace(
  workspaceRoot: string,
  scopePath?: string,
  database?: Database,
  options?: { rebuild?: boolean }
): Promise<SyncStats> {
  const absRoot = database
    ? canonicalizePath(workspaceRoot)
    : (resolveIndexedWorkspaceRoot(workspaceRoot) ?? canonicalizePath(workspaceRoot));
  const db = database ?? getWorkspaceDatabase(absRoot);
  const previous = syncQueues.get(db) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    if (options?.rebuild) {
      db.transaction(() => {
        assertCompatibleSchema(db);
        db.run("INSERT OR REPLACE INTO meta(key,value) VALUES ('index_invalid','1')");
      }).immediate();
    }
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await stagedSync(absRoot, scopePath, db);
      } catch (err) {
        const isBusy =
          (err as { code?: string })?.code === 'SQLITE_BUSY' ||
          (err instanceof Error && (err.message.includes('locked') || err.message.includes('busy') || err.message.includes('SQLITE_BUSY')));
        const isWorkspaceChanged = err instanceof Error && err.message.startsWith('WORKSPACE_CHANGED');

        if (attempt < maxRetries - 1 && (isBusy || isWorkspaceChanged)) {
          if (isBusy) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
          continue;
        }
        throw err;
      }
    }
    throw new Error('syncWorkspace: retries exhausted');
  });
  syncQueues.set(db, operation);
  try { return await operation; }
  finally { if (syncQueues.get(db) === operation) syncQueues.delete(db); }
}

const syncQueues = new WeakMap<Database, Promise<unknown>>();
