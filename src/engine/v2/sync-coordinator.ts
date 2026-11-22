import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { defaultPluginRegistry } from '../../plugins';
import { IGNORED_DIRS, isConfigFile } from '../collector';
import { canonicalizePath } from '../path-resolver';
import {
  syncDirtyFilesV3,
  syncWorkspaceV3,
  type DirtySyncFileCache,
  type FastSyncOptions,
  type FastSyncStats,
} from './fast-sync';
import { defaultWarmDbPool } from './schema-v3';

const MAX_DIRTY_QUEUE_SIZE = 100;

interface WatchedWorkspaceState {
  absRoot: string;
  watcher: FSWatcher | null;
  watcherActive: boolean;
  initialSyncDone: boolean;
  needsFullSync: boolean;
  dirtyFiles: Set<string>;
  fileCache?: DirtySyncFileCache;
}

function hasIgnoredSegment(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (IGNORED_DIRS.has(seg) || IGNORED_DIRS.has(seg.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isWorkspaceConfigTrigger(fileName: string): boolean {
  return (
    fileName === 'pnpm-workspace.yaml' ||
    fileName === '.gitignore' ||
    fileName === '.strataignore' ||
    isConfigFile(fileName)
  );
}

/**
 * Runtime Sync Coordinator for Strata MCP:
 * - Single-flight sync coalescing across concurrent tool calls & background warmup.
 * - Optional recursive fs.watch dirty-file queue turning hot-loop syncs from O(F) into O(|dirtyFiles|).
 * - Non-blocking startup background warmup for initialized workspaces.
 */
export class WorkspaceSyncCoordinator {
  private readonly inFlight = new Map<string, Promise<FastSyncStats>>();
  private readonly watched = new Map<string, WatchedWorkspaceState>();

  private flightKey(absRoot: string, options: FastSyncOptions): string {
    return `${absRoot}\0${options.packageKey ?? '*'}\0${options.dbFilename ?? 'graph.db'}`;
  }

  /**
   * Attaches a lightweight recursive fs.watch listener for a workspace (idempotent).
   * Gracefully falls back to full sync if the platform/OS rejects recursive watching.
   */
  startWatching(workspaceRoot: string): boolean {
    const absRoot = canonicalizePath(workspaceRoot);
    const existing = this.watched.get(absRoot);
    if (existing?.watcherActive) return true;

    const supportedExts = defaultPluginRegistry.supportedExtensions();
    const state: WatchedWorkspaceState = existing ?? {
      absRoot,
      watcher: null,
      watcherActive: false,
      initialSyncDone: false,
      needsFullSync: true,
      dirtyFiles: new Set<string>(),
    };

    try {
      const watcher = watch(absRoot, { recursive: true }, (_eventType, rawFilename) => {
        if (!rawFilename) {
          state.needsFullSync = true;
          state.dirtyFiles.clear();
          return;
        }
        const rel = typeof rawFilename === 'string' ? rawFilename : String(rawFilename);
        if (hasIgnoredSegment(rel)) return;

        const base = basename(rel);
        if (isWorkspaceConfigTrigger(base)) {
          state.needsFullSync = true;
          state.dirtyFiles.clear();
          return;
        }

        const ext = extname(base).toLowerCase();
        if (!supportedExts.has(ext)) return;

        if (state.needsFullSync) return;
        state.dirtyFiles.add(canonicalizePath(join(absRoot, rel)));
        if (state.dirtyFiles.size > MAX_DIRTY_QUEUE_SIZE) {
          state.needsFullSync = true;
          state.dirtyFiles.clear();
        }
      });

      watcher.on('error', () => {
        state.watcherActive = false;
        state.needsFullSync = true;
        state.dirtyFiles.clear();
        try {
          watcher.close();
        } catch {
          // ignore
        }
        state.watcher = null;
      });

      if (typeof watcher.unref === 'function') {
        watcher.unref();
      }

      state.watcher = watcher;
      state.watcherActive = true;
      this.watched.set(absRoot, state);
      return true;
    } catch {
      state.watcher = null;
      state.watcherActive = false;
      state.needsFullSync = true;
      this.watched.set(absRoot, state);
      return false;
    }
  }

  isWatching(workspaceRoot: string): boolean {
    return Boolean(this.watched.get(canonicalizePath(workspaceRoot))?.watcherActive);
  }

  /**
   * Explicitly records a modified/added/deleted file into the dirty queue (useful for hooks & tests).
   */
  markDirty(workspaceRoot: string, filePath: string): void {
    const absRoot = canonicalizePath(workspaceRoot);
    const state = this.watched.get(absRoot);
    if (!state || state.needsFullSync) return;
    const base = basename(filePath);
    if (isWorkspaceConfigTrigger(base)) {
      state.needsFullSync = true;
      state.dirtyFiles.clear();
      return;
    }
    state.dirtyFiles.add(canonicalizePath(filePath));
    if (state.dirtyFiles.size > MAX_DIRTY_QUEUE_SIZE) {
      state.needsFullSync = true;
      state.dirtyFiles.clear();
    }
  }

  /**
   * Non-blocking startup warmup for an already-initialized workspace (.strata/graph.db exists).
   * Starts the file watcher and coalesces onto the single-flight sync promise.
   */
  warmupInBackground(workspaceRoot: string): Promise<FastSyncStats> | null {
    const absRoot = canonicalizePath(workspaceRoot);
    if (!existsSync(join(absRoot, '.strata', 'graph.db'))) {
      return null;
    }
    this.startWatching(absRoot);
    const promise = this.ensureSynced(absRoot).catch(() => ({
      mode: 'incremental' as const,
      packagesSynced: 0,
      added: 0,
      modified: 0,
      unchanged: 0,
      deleted: 0,
      symbolsIndexed: 0,
      edgesIndexed: 0,
      durationMs: 0,
    }));
    return promise;
  }

  /**
   * Coalesced workspace sync entry point:
   * - Single-flight deduplication across concurrent callers.
   * - Uses O(1) watcher-clean fast path or O(|dirtyFiles|) targeted sync when watcher is active.
   */
  async ensureSynced(
    workspaceRoot: string,
    options: FastSyncOptions = {}
  ): Promise<FastSyncStats> {
    const absRoot = canonicalizePath(workspaceRoot);
    const key = this.flightKey(absRoot, options);

    if (!options.force) {
      const existingFlight = this.inFlight.get(key);
      if (existingFlight) {
        return existingFlight;
      }
    } else {
      const existingFlight = this.inFlight.get(key);
      if (existingFlight) {
        await existingFlight.catch(() => {});
      }
    }

    const task = this.executeSync(absRoot, options);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(key) === task) {
        this.inFlight.delete(key);
      }
    }
  }

  private async executeSync(
    absRoot: string,
    options: FastSyncOptions
  ): Promise<FastSyncStats> {
    const state = this.watched.get(absRoot);

    // Fast paths only apply when watcher is actively tracking the full workspace
    if (
      state &&
      state.watcherActive &&
      state.initialSyncDone &&
      !options.force &&
      !options.packageKey &&
      !options.dbFilename
    ) {
      if (!state.needsFullSync && state.dirtyFiles.size === 0) {
        const db = options.db ?? defaultWarmDbPool.get(absRoot, options);
        const counts = db
          .query(
            'SELECT (SELECT count(*) FROM packages) AS p, (SELECT count(*) FROM files) AS f, (SELECT count(*) FROM symbols) AS s, (SELECT count(*) FROM symbol_edges) AS e'
          )
          .get() as { p: number; f: number; s: number; e: number };
        return {
          mode: 'watcher-clean',
          packagesSynced: counts.p,
          added: 0,
          modified: 0,
          unchanged: counts.f,
          deleted: 0,
          symbolsIndexed: counts.s,
          edgesIndexed: counts.e,
          durationMs: 0,
          workersUsed: 1,
        };
      }

      if (!state.needsFullSync && state.dirtyFiles.size > 0) {
        const batch = Array.from(state.dirtyFiles);
        state.dirtyFiles.clear();
        if (!state.fileCache) {
          const db = options.db ?? defaultWarmDbPool.get(absRoot, options);
          const rows = db.query('SELECT id, path FROM files').all() as Array<{
            id: number;
            path: string;
          }>;
          const fileIdByPath = new Map<string, number>();
          const knownFiles = new Set<string>();
          for (const r of rows) {
            fileIdByPath.set(r.path, r.id);
            knownFiles.add(r.path);
          }
          state.fileCache = { fileIdByPath, knownFiles };
        }
        try {
          return await syncDirtyFilesV3(absRoot, batch, options, state.fileCache);
        } catch (err) {
          state.needsFullSync = true;
          state.fileCache = undefined;
          throw err;
        }
      }
    }

    // Full or standard incremental sync
    if (state && !options.packageKey && !options.dbFilename) {
      state.needsFullSync = false;
      state.dirtyFiles.clear();
      state.fileCache = undefined;
    }

    try {
      const stats = await syncWorkspaceV3(absRoot, options);
      if (state && !options.packageKey && !options.dbFilename) {
        state.initialSyncDone = true;
      }
      return stats;
    } catch (err) {
      if (state && !options.packageKey && !options.dbFilename) {
        state.needsFullSync = true;
        state.fileCache = undefined;
      }
      throw err;
    }
  }

  close(workspaceRoot: string): void {
    const absRoot = canonicalizePath(workspaceRoot);
    const state = this.watched.get(absRoot);
    if (state?.watcher) {
      try {
        state.watcher.close();
      } catch {
        // ignore
      }
      state.watcher = null;
      state.watcherActive = false;
    }
    this.watched.delete(absRoot);
  }

  closeAll(): void {
    for (const state of this.watched.values()) {
      if (state.watcher) {
        try {
          state.watcher.close();
        } catch {
          // ignore
        }
        state.watcher = null;
        state.watcherActive = false;
      }
    }
    this.watched.clear();
  }
}

export const defaultSyncCoordinator = new WorkspaceSyncCoordinator();
