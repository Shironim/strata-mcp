import { existsSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  ExtractedWorkResult,
  MtimeOnlyUpdate,
  ParseWorkItem,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './parse-worker';
import type { WorkspacePackageInfo } from './workspace-packages';

export const DEFAULT_PARALLEL_PARSE_THRESHOLD = 1000;
const WORKER_CHUNK_SIZE = 128;
const MAX_WORKERS = 4;

export interface ParallelParseOptions {
  items: ParseWorkItem[];
  allPackages: WorkspacePackageInfo[];
  knownFiles: ReadonlySet<string>;
  force: boolean;
  maxWorkers?: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface ParallelParseResult {
  extracted: ExtractedWorkResult[];
  mtimeOnlyUpdates: MtimeOnlyUpdate[];
  parsedCount: number;
  workersUsed: number;
}

function resolveWorkerScriptUrl(): URL | null {
  const candidates = ['./parse-worker.ts', './parse-worker.js', './engine/v2/parse-worker.js'];
  for (const rel of candidates) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && existsSync(fileURLToPath(url))) {
        return url;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function getCpuCount(): number {
  try {
    if (typeof availableParallelism === 'function') return availableParallelism();
  } catch {
    // fallback
  }
  return Math.max(1, cpus().length);
}

/**
 * Executes Stage-2 Tier-1 AST parsing in parallel across a bounded Bun Worker pool.
 * Returns null if multi-core workers are unavailable, allowing seamless main-thread fallback.
 */
export async function parseFilesInWorkerPool(
  options: ParallelParseOptions
): Promise<ParallelParseResult | null> {
  const { items, allPackages, knownFiles, force, onProgress } = options;
  if (items.length === 0 || typeof Worker === 'undefined') return null;

  const cpuCount = getCpuCount();
  if (cpuCount <= 1) return null;

  const workerUrl = resolveWorkerScriptUrl();
  if (!workerUrl) return null;

  const cap = options.maxWorkers ?? MAX_WORKERS;
  const workerCount = Math.max(
    1,
    Math.min(cpuCount - 1, cap, Math.ceil(items.length / 48))
  );
  if (workerCount <= 1) return null;

  // Partition work into balanced chunks for work-stealing dispatch
  const chunkSize = Math.max(32, Math.min(WORKER_CHUNK_SIZE, Math.ceil(items.length / (workerCount * 3))));
  const chunks: ParseWorkItem[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  const knownFilesArray = Array.from(knownFiles);
  const extracted: ExtractedWorkResult[] = [];
  const mtimeOnlyUpdates: MtimeOnlyUpdate[] = [];
  let completedFiles = 0;
  let completedChunks = 0;
  let nextChunkIdx = 0;

  const workers: Worker[] = [];

  try {
    for (let i = 0; i < workerCount; i++) {
      workers.push(new Worker(workerUrl.href, { type: 'module' }));
    }
  } catch {
    for (const w of workers) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
    }
    return null;
  }

  try {
    await new Promise<void>((resolveAll, rejectAll) => {
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        rejectAll(err);
      };

      const dispatchNext = (worker: Worker) => {
        if (settled || nextChunkIdx >= chunks.length) return;
        const chunkId = nextChunkIdx++;
        worker.postMessage({
          type: 'chunk',
          chunkId,
          items: chunks[chunkId]!,
        } satisfies WorkerInboundMessage);
      };

      for (const worker of workers) {
        worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
          if (settled) return;
          const msg = event.data;

          if (msg.type === 'ready') {
            dispatchNext(worker);
            return;
          }

          if (msg.type === 'chunkResult') {
            for (const item of msg.extracted) extracted.push(item);
            for (const upd of msg.mtimeOnlyUpdates) mtimeOnlyUpdates.push(upd);
            completedFiles += msg.parsedCount;
            completedChunks++;
            onProgress?.(completedFiles, items.length);

            if (completedChunks >= chunks.length) {
              settled = true;
              resolveAll();
            } else {
              dispatchNext(worker);
            }
            return;
          }

          if (msg.type === 'error') {
            fail(new Error(`Parse worker error: ${msg.message}`));
          }
        };

        worker.onerror = (ev) => {
          fail(new Error(`Parse worker crashed: ${ev.message || 'unknown error'}`));
        };

        worker.postMessage({
          type: 'init',
          allPackages,
          knownFiles: knownFilesArray,
          force,
        } satisfies WorkerInboundMessage);
      }
    });

    return {
      extracted,
      mtimeOnlyUpdates,
      parsedCount: completedFiles,
      workersUsed: workerCount,
    };
  } finally {
    for (const w of workers) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
    }
  }
}
