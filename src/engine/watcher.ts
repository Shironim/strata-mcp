import { watch, type FSWatcher } from 'node:fs';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { join, normalize, relative, resolve, extname, basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  detectFramework,
  extractComponentContract,
  extractRenderBoundary,
  extractStateDependencies,
} from './contract';
import {
  extractLocalImports,
  isPageFile,
  extractPassedProps,
  extractComponentContextNodes,
} from './tree';
import { getCandidateNames } from './template';
import { scanRoutes } from './routes';
import { isLayoutFile } from './database';
import type { EdgePayload } from '../types';

const SUPPORTED_EXTENSIONS = new Set(['.vue', '.astro', '.tsx', '.jsx', '.ts', '.js']);

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.strata',
  'dist',
  '.output',
  '.nuxt',
  '.next',
  '.astro',
  '.turbo',
  'build',
  'coverage',
  '.cache',
]);

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
  batchThreshold?: number;
  onSyncComplete?: (changedFiles: string[]) => void;
  onError?: (err: Error) => void;
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
 * Updates the SQLite cache incrementally on changes without disk scanning.
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

  constructor(absRoot: string, db: Database, options?: WatcherOptions) {
    this.absRoot = resolve(absRoot);
    this.db = db;
    this.options = {
      debounceMs: options?.debounceMs ?? 100,
      batchThreshold: options?.batchThreshold ?? 50,
      onSyncComplete: options?.onSyncComplete ?? (() => {}),
      onError:
        options?.onError ??
        ((err) => {
          process.stderr.write(`[strata-watcher] Warning: ${err.message}\n`);
        }),
    };
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

      this.fsWatcher.on('error', (err: Error) => {
        this.options.onError(err);
        this.close();
      });

      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Graceful fallback on OS watch limitations (e.g. Linux inotify ENOSPC)
      this.options.onError(
        new Error(
          `Recursive watch unavailable on "${this.absRoot}" (${error.message}). Falling back to on-demand sync.`
        )
      );
      this.close();
      return false;
    }
  }

  /**
   * Handles incoming raw FS event, filters unwanted paths, and debounces batch processing.
   */
  private handleFsEvent(relPath: string): void {
    const normalizedRel = normalizePath(relPath);

    if (isPathIgnored(normalizedRel)) {
      return;
    }

    if (!isSupportedFile(normalizedRel)) {
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
      // Circuit breaker: If too many files changed in a single debounce window (e.g. git checkout),
      // avoid per-file thrashing and defer to a full batch sync via external hook.
      if (pathsToProcess.length > this.options.batchThreshold) {
        process.stderr.write(
          `[strata-watcher] Event storm detected (${pathsToProcess.length} files). Triggering batch re-sync.\n`
        );
        const { syncWorkspaceDelta, hashChecker } = await import('./database');
        const delta = await hashChecker(this.absRoot, this.db);
        await syncWorkspaceDelta(this.db, this.absRoot, delta);
        this.options.onSyncComplete(pathsToProcess);
        return;
      }

      let hasPageOrRouteChanged = false;

      for (const relPath of pathsToProcess) {
        const fullPath = join(this.absRoot, relPath);
        const normRel = normalizePath(relPath);

        if (!existsSync(fullPath)) {
          // File was deleted
          this.removeSingleFile(normRel);
          if (isPageFile(fullPath)) {
            hasPageOrRouteChanged = true;
          }
        } else {
          // File was created or modified
          try {
            const stats = statSync(fullPath);
            if (stats.size === 0) {
              // Ignore transient 0-byte writes during IDE save
              continue;
            }
            await this.updateSingleFile(fullPath, normRel, stats.mtimeMs, stats.size);
            if (isPageFile(fullPath)) {
              hasPageOrRouteChanged = true;
            }
          } catch {
            // File might have been deleted between existsSync and statSync
            this.removeSingleFile(normRel);
          }
        }
      }

      // If any page/route file changed, refresh routes manifest
      if (hasPageOrRouteChanged) {
        try {
          const manifest = await scanRoutes({ targetPath: this.absRoot });
          if (manifest.routes.length > 0) {
            const deleteRoutesStmt = this.db.prepare(`DELETE FROM routes;`);
            const insertRouteStmt = this.db.prepare(`
              INSERT OR REPLACE INTO routes (route_path, file_path, framework, dynamic_params)
              VALUES ($route_path, $file_path, $framework, $dynamic_params);
            `);

            this.db.transaction(() => {
              deleteRoutesStmt.run();
              for (const r of manifest.routes) {
                insertRouteStmt.run({
                  $route_path: r.path,
                  $file_path: r.componentPath,
                  $framework: r.framework,
                  $dynamic_params: JSON.stringify(r.params ?? []),
                });
              }
            })();
          }
        } catch {
          // Ignore route re-scan failure
        }
      }

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
   * Updates a single file entry and its AST contracts atomically in SQLite.
   */
  private async updateSingleFile(
    fullPath: string,
    normRel: string,
    mtime: number,
    size: number
  ): Promise<void> {
    const code = await fs.readFile(fullPath, 'utf-8');
    const framework = detectFramework(fullPath, code);
    const boundary = extractRenderBoundary(fullPath, code);
    const stateDeps = extractStateDependencies(fullPath, code);
    const isPage = isPageFile(fullPath);
    const isLayout = isLayoutFile(fullPath);

    let compName = basename(fullPath, extname(fullPath));
    let contract = null;
    try {
      contract = await extractComponentContract(fullPath, { framework });
      if (contract?.name) {
        compName = contract.name;
      }
    } catch {
      // Syntax might be transiently invalid during active typing in editor.
      // Do not abort; proceed with file metadata to keep tracking mtime.
    }

    const imports = extractLocalImports(fullPath, code, {
      aliases: { '@': join(this.absRoot, 'src') },
    });
    const { providers, consumers } = extractComponentContextNodes(fullPath, code);

    const edges: Array<{ targetPath: string; isDynamic: boolean; payload?: EdgePayload }> = [];
    const supportedExts = ['.vue', '.astro', '.tsx', '.jsx', '.ts', '.js'];

    for (const imp of imports) {
      if (imp.source.startsWith('.')) {
        const impDir = resolve(fullPath, '..');
        const resolvedBase = resolve(impDir, imp.source);
        let matchedPath: string | null = null;
        let matchedCandidate: string | null = null;

        for (const ext of supportedExts) {
          const candidate = resolvedBase + ext;
          if (existsSync(candidate)) {
            matchedPath = normalizePath(relative(this.absRoot, candidate));
            matchedCandidate = candidate;
            break;
          }
        }

        if (matchedPath && matchedCandidate) {
          const candidateNames = getCandidateNames(imp.name || basename(matchedCandidate, extname(matchedCandidate)));
          const passedProps = extractPassedProps(code, candidateNames);

          edges.push({
            targetPath: matchedPath,
            isDynamic: imp.isDynamic ?? false,
            payload: {
              passedProps: passedProps.length > 0 ? passedProps : undefined,
              contexts: (providers.length > 0 || consumers.length > 0) ? {
                provided: providers.length > 0 ? providers : undefined,
                consumed: consumers.length > 0 ? consumers : undefined,
              } : undefined,
            },
          });
        }
      }
    }

    // Atomic SQLite upsert
    const upsertFileStmt = this.db.prepare(`
      INSERT INTO files (path, framework, mtime, size, is_page, is_layout, render_boundary, boundary_directive)
      VALUES ($path, $framework, $mtime, $size, $is_page, $is_layout, $render_boundary, $boundary_directive)
      ON CONFLICT(path) DO UPDATE SET
        framework = excluded.framework,
        mtime = excluded.mtime,
        size = excluded.size,
        is_page = excluded.is_page,
        is_layout = excluded.is_layout,
        render_boundary = excluded.render_boundary,
        boundary_directive = excluded.boundary_directive
      RETURNING id;
    `);

    const cleanRelationsStmt = this.db.prepare(`
      DELETE FROM components WHERE file_id = $id;
      DELETE FROM edges WHERE parent_file_id = $id;
      DELETE FROM state_deps WHERE file_id = $id;
    `);

    const insertComponentStmt = this.db.prepare(`
      INSERT OR REPLACE INTO components (file_id, name, contract_json)
      VALUES ($file_id, $name, $contract_json);
    `);

    const insertStateDepStmt = this.db.prepare(`
      INSERT INTO state_deps (file_id, kind, identifier, access_mode, line_number, usage_snippet)
      VALUES ($file_id, $kind, $identifier, $access_mode, $line_number, $usage_snippet);
    `);

    const findTargetFileIdStmt = this.db.prepare(`
      SELECT id FROM files WHERE path = ?;
    `);

    const insertEdgeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO edges (parent_file_id, child_file_id, import_type, is_rendered, payload_json)
      VALUES ($parent_file_id, $child_file_id, $import_type, $is_rendered, $payload_json);
    `);

    this.db.transaction(() => {
      const fileRow = upsertFileStmt.get({
        $path: normRel,
        $framework: framework,
        $mtime: mtime,
        $size: size,
        $is_page: isPage ? 1 : 0,
        $is_layout: isLayout ? 1 : 0,
        $render_boundary: boundary.boundary,
        $boundary_directive: boundary.directive ?? null,
      }) as { id: number } | undefined;

      if (!fileRow) {
        return;
      }

      const fileId = fileRow.id;
      cleanRelationsStmt.run({ $id: fileId });

      if (contract) {
        insertComponentStmt.run({
          $file_id: fileId,
          $name: compName,
          $contract_json: JSON.stringify(contract),
        });
      }

      if (stateDeps.items && stateDeps.items.length > 0) {
        for (const item of stateDeps.items) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: item.kind,
            $identifier: item.identifier,
            $access_mode: item.accessMode,
            $line_number: item.lineNumber ?? 0,
            $usage_snippet: item.usageSnippet ?? null,
          });
        }
      } else {
        for (const st of stateDeps.stores) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'store',
            $identifier: st,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
        for (const ctx of stateDeps.contexts) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'context',
            $identifier: ctx,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
        for (const cmp of stateDeps.composables) {
          insertStateDepStmt.run({
            $file_id: fileId,
            $kind: 'composable',
            $identifier: cmp,
            $access_mode: 'read',
            $line_number: 0,
            $usage_snippet: null,
          });
        }
      }

      for (const edge of edges) {
        const targetRow = findTargetFileIdStmt.get(edge.targetPath) as { id: number } | undefined;
        if (targetRow) {
          insertEdgeStmt.run({
            $parent_file_id: fileId,
            $child_file_id: targetRow.id,
            $import_type: edge.isDynamic ? 'dynamic' : 'static',
            $is_rendered: 1,
            $payload_json: edge.payload ? JSON.stringify(edge.payload) : null,
          });
        }
      }
    })();
  }

  /**
   * Deletes a single file entry and cleans up relationships in SQLite.
   */
  private removeSingleFile(normRel: string): void {
    const findFileStmt = this.db.prepare(`SELECT id FROM files WHERE path = ?;`);
    const fileRow = findFileStmt.get(normRel) as { id: number } | undefined;
    if (!fileRow) {
      return;
    }

    const fileId = fileRow.id;
    const deleteFileStmt = this.db.prepare(`DELETE FROM files WHERE id = ?;`);
    const cleanRelationsStmt = this.db.prepare(`
      DELETE FROM components WHERE file_id = $id;
      DELETE FROM edges WHERE parent_file_id = $id OR child_file_id = $id;
      DELETE FROM state_deps WHERE file_id = $id;
    `);

    this.db.transaction(() => {
      cleanRelationsStmt.run({ $id: fileId });
      deleteFileStmt.run(fileId);
    })();
  }

  /**
   * Closes the watcher and frees system resources.
   */
  public close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
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
  for (const [root, watcher] of activeWatchers.entries()) {
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
