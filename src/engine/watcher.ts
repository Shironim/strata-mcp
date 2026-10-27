import { watch, type FSWatcher } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import { IGNORED_DIRS, INDEX_CONFIG_FILES, SUPPORTED_FRONTEND_EXTENSIONS } from './collector';

const SUPPORTED_EXTENSIONS = SUPPORTED_FRONTEND_EXTENSIONS;
const IGNORED_DIR_NAMES = new Set([...IGNORED_DIRS, '.strata', '.vue-ast']);

const IGNORED_FILE_PATTERNS = [
  /^\..*\.swp$/,
  /^\..*\.tmp$/,
  /~$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/i,
  /\.log$/,
];

export interface WatcherOptions {
  debounceMs?: number;
  /** @deprecated All event batches now share the delta sync pipeline. */
  batchThreshold?: number;
  onSyncComplete?: (changedFiles: string[]) => void;
  onError?: (err: Error) => void;
  scopeSubdirs?: string[];
  fallbackPolling?: boolean;
  pollingIntervalMs?: number;
}

/**
 * Normalizes file path to forward slashes.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Checks if a relative or absolute path should be ignored by the watcher.
 */
export function isPathIgnored(pathOrName: string): boolean {
  const norm = normalizePath(pathOrName);
  const segments = norm.split('/');

  for (const seg of segments) {
    if (IGNORED_DIR_NAMES.has(seg)) {
      return true;
    }
  }

  const fileBase = basename(norm);
  for (const pattern of IGNORED_FILE_PATTERNS) {
    if (pattern.test(fileBase)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a file path is a supported source extension.
 */
export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * WorkspaceWatcher: Manages a reactive file watcher over the workspace root.
 * Uses the shared delta sync pipeline for consistent paths, imports, and ignore rules.
 */
export class WorkspaceWatcher {
  private absRoot: string;
  private db: Database;
  private options: Required<WatcherOptions>;
  private fsWatcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingDirtyPaths = new Set<string>();
  private isProcessing = false;
  private isClosed = false;
  private isDegradedMode = false;
  private mode: 'native' | 'polling' | 'degraded' | 'closed' = 'closed';
  private pollingTimer: NodeJS.Timeout | null = null;

  constructor(absRoot: string, db: Database, options?: WatcherOptions) {
    this.absRoot = resolve(absRoot);
    this.db = db;
    this.options = {
      debounceMs: options?.debounceMs ?? 100,
      batchThreshold: options?.batchThreshold ?? 50,
      onSyncComplete: options?.onSyncComplete ?? (() => {}),
      scopeSubdirs: options?.scopeSubdirs ?? [],
      fallbackPolling: options?.fallbackPolling ?? false,
      pollingIntervalMs: options?.pollingIntervalMs ?? 3000,
      onError:
        options?.onError ??
        ((err) => {
          process.stderr.write(`[strata-watcher] Warning: ${err.message}\n`);
        }),
    };
  }

  /**
   * Returns whether the watcher is in a degraded fallback state.
   */
  public isDegraded(): boolean {
    return this.isDegradedMode;
  }

  /**
   * Returns current watcher lifecycle status.
   */
  public getStatus(): {
    active: boolean;
    degraded: boolean;
    mode: 'native' | 'polling' | 'degraded' | 'closed';
  } {
    return {
      active: (this.mode === 'native' || this.mode === 'polling') && !this.isClosed,
      degraded: this.isDegradedMode,
      mode: this.mode,
    };
  }

  /**
   * Handles watcher runtime or setup error, transitioning to degraded or polling mode.
   */
  public handleWatchError(err: Error): void {
    this.isDegradedMode = true;
    this.options.onError(err);
    if (this.options.fallbackPolling && !this.isClosed) {
      this.enablePollingFallback();
    } else {
      this.mode = 'degraded';
      if (this.fsWatcher) {
        try {
          this.fsWatcher.close();
        } catch {
          // ignore
        }
        this.fsWatcher = null;
      }
    }
  }

  /**
   * Activates interval-based polling fallback when native OS watching is exhausted or unavailable.
   */
  public enablePollingFallback(): void {
    if (this.isClosed) return;
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore
      }
      this.fsWatcher = null;
    }
    this.mode = 'polling';
    this.isDegradedMode = true;
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    const interval = this.options.pollingIntervalMs ?? 3000;
    this.pollingTimer = setInterval(async () => {
      if (this.isClosed || this.isProcessing) return;
      try {
        const { syncWorkspace } = await import('./storage/delta-sync');
        const stats = await syncWorkspace(this.absRoot, undefined, this.db);
        if (stats.added > 0 || stats.modified > 0 || stats.deleted > 0) {
          this.options.onSyncComplete([]);
        }
      } catch (pollErr) {
        this.options.onError(pollErr instanceof Error ? pollErr : new Error(String(pollErr)));
      }
    }, interval);
    this.pollingTimer.unref?.();
  }

  /**
   * Starts the filesystem watcher.
   * Gracefully degrades if the OS or kernel watcher quota is exhausted (ENOSPC).
   */
  public start(): boolean {
    if (this.fsWatcher || this.isClosed) {
      return false;
    }

    try {
      this.fsWatcher = watch(
        this.absRoot,
        { recursive: true },
        (_eventType: string, filename: string | null) => {
          if (!filename || this.isClosed) {
            return;
          }
          this.handleFsEvent(filename);
        }
      );

      this.mode = 'native';
      this.fsWatcher.on('error', (err: Error) => {
        this.handleWatchError(err);
      });

      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Graceful fallback on OS watch limitations (e.g. Linux inotify ENOSPC)
      this.handleWatchError(
        new Error(
          `Recursive watch unavailable on "${this.absRoot}" (${error.message}). Falling back to on-demand sync.`
        )
      );
      return false;
    }
  }

  /**
   * Handles incoming raw FS event, filters unwanted paths, and debounces batch processing.
   */
  private handleFsEvent(relPath: string): void {
    if (this.isClosed) return;
    const normalizedRel = normalizePath(relPath);

    const fileName = basename(normalizedRel);
    const isConfig = INDEX_CONFIG_FILES.has(fileName) || /^(nuxt|next|astro|svelte)\.config\.(ts|js|mjs)$/.test(fileName);
    if (this.options.scopeSubdirs.length > 0 && !isConfig) {
      const inScope = this.options.scopeSubdirs.some(
        (dir) => normalizedRel === dir || normalizedRel.startsWith(`${dir}/`)
      );
      if (!inScope) return;
    }

    if (isPathIgnored(normalizedRel)) {
      return;
    }

    if (!isConfig && !isSupportedFile(normalizedRel)) {
      return;
    }

    this.pendingDirtyPaths.add(normalizedRel);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushQueue().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError(error);
      });
    }, this.options.debounceMs);
  }

  /**
   * Flushes the pending dirty files queue to the SQLite database.
   */
  public async flushQueue(): Promise<void> {
    if (this.isClosed || this.isProcessing || this.pendingDirtyPaths.size === 0) {
      return;
    }

    this.isProcessing = true;
    const pathsToProcess = Array.from(this.pendingDirtyPaths);
    this.pendingDirtyPaths.clear();

    try {
      const { syncWorkspace } = await import('./storage/delta-sync');
      await syncWorkspace(this.absRoot, undefined, this.db);
      this.options.onSyncComplete(pathsToProcess);
    } finally {
      this.isProcessing = false;
      // If new events arrived while processing, schedule another flush
      if (this.pendingDirtyPaths.size > 0 && !this.isClosed) {
        this.debounceTimer = setTimeout(() => {
          this.flushQueue().catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.options.onError(error);
          });
        }, this.options.debounceMs);
      }
    }
  }

  /**
   * Closes the watcher and frees system resources.
   */
  public close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.mode = 'closed';
    this.pendingDirtyPaths.clear();
    if (activeWatchers.get(this.absRoot) === this) activeWatchers.delete(this.absRoot);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore close errors
      }
      this.fsWatcher = null;
    }
  }
}

/**
 * Global singleton registry for active workspace watchers.
 */
const activeWatchers = new Map<string, WorkspaceWatcher>();

/**
 * Starts or retrieves an active watcher for the workspace root.
 */
export function startWorkspaceWatcher(
  absRoot: string,
  db: Database,
  options?: WatcherOptions
): WorkspaceWatcher | null {
  const normRoot = resolve(absRoot);
  const existing = activeWatchers.get(normRoot);
  if (existing) {
    return existing;
  }

  const watcher = new WorkspaceWatcher(normRoot, db, options);
  const started = watcher.start();
  if (started) {
    activeWatchers.set(normRoot, watcher);
    return watcher;
  }

  return null;
}

/**
 * Stops the watcher for a specific workspace root.
 */
export function stopWorkspaceWatcher(absRoot: string): void {
  const normRoot = resolve(absRoot);
  const watcher = activeWatchers.get(normRoot);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(normRoot);
  }
}

/**
 * Stops all active workspace watchers (for graceful server shutdown).
 */
export function stopAllWorkspaceWatchers(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.close();
  }
  activeWatchers.clear();
}

// Process-level graceful exit handlers to prevent file descriptor leaks
if (typeof process !== 'undefined' && process.on) {
  process.on('exit', () => {
    stopAllWorkspaceWatchers();
  });
}
