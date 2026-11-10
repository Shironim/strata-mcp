import { findTool } from './tools';
import { closeAllDatabases } from './engine/storage/schema';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from './engine/path-resolver';
import type { ToolCallResponse } from './tools/types';

export interface AnalysisResponse extends ToolCallResponse {
  projectRoot?: string;
}

export const ANALYSIS_LIMITS = {
  requestBytes: 2 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  queued: 4,
  timeoutMs: 120000,
  sampleMs: 50,
  combinedBytes: 448 * 1024 * 1024,
  analysisBytes: 384 * 1024 * 1024,
};

interface Job {
  name: string;
  args: Record<string, unknown>;
  rootHint?: string;
  signal?: AbortSignal;
  resolve: (response: AnalysisResponse) => void;
  reject: (error: Error) => void;
  removeAbort?: () => void;
}

export interface SupervisorOptions {
  workerPath?: string;
  limits?: Partial<typeof ANALYSIS_LIMITS>;
}

export class AnalysisSupervisor {
  private queue: Job[] = [];
  private active?: Job;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly limits: typeof ANALYSIS_LIMITS;

  constructor(options: SupervisorOptions = {}) {
    this.limits = { ...ANALYSIS_LIMITS, ...options.limits };
  }

  run(
    name: string,
    args: Record<string, unknown>,
    rootHint?: string,
    signal?: AbortSignal
  ): Promise<AnalysisResponse> {
    if (this.closed) return Promise.reject(new Error('SERVER_CLOSED: analysis supervisor is closed'));
    if (signal?.aborted) return Promise.reject(new Error('REQUEST_CANCELLED: analysis cancelled'));

    const input = JSON.stringify({ name, args, rootHint });
    if (Buffer.byteLength(input) > this.limits.requestBytes) {
      return Promise.reject(new Error('REQUEST_TOO_LARGE: maximum request is 2 MiB'));
    }
    if (this.active && this.queue.length >= this.limits.queued) {
      return Promise.reject(new Error('SERVER_BUSY: four analysis requests are already waiting'));
    }

    return new Promise((resolve, reject) => {
      const job: Job = { name, args, rootHint, signal, resolve, reject };
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          job.removeAbort?.();
          reject(new Error('REQUEST_CANCELLED: queued analysis cancelled'));
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      job.removeAbort = () => signal?.removeEventListener('abort', abort);
      this.queue.push(job);
      this.next();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.removeAbort?.();
      job.reject(new Error('SERVER_CLOSED: analysis cancelled'));
    }
    if (this.active) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private next(): void {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;

    void this.execute(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        job.removeAbort?.();
        this.active = undefined;
        this.idleWaiters.splice(0).forEach((resolve) => resolve());
        this.next();
      });
  }

  private async execute(job: Job): Promise<AnalysisResponse> {
    if (job.signal?.aborted || this.closed) {
      throw new Error('REQUEST_CANCELLED: analysis cancelled');
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error('ANALYSIS_TIMEOUT: maximum analysis duration is 120 seconds'));
      }, this.limits.timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (job.signal?.aborted) {
        reject(new Error('REQUEST_CANCELLED: analysis cancelled'));
        return;
      }
      abortListener = () => reject(new Error('REQUEST_CANCELLED: analysis cancelled'));
      job.signal?.addEventListener('abort', abortListener, { once: true });
    });

    const executionPromise = (async (): Promise<AnalysisResponse> => {
      if (job.rootHint) setLastKnownProjectRoot(job.rootHint);
      const tool = findTool(job.name);
      if (!tool) throw new Error(`UNKNOWN_TOOL: ${job.name}`);

      let response: ToolCallResponse;
      let detectedRoot: string | undefined;
      try {
        response = await tool.handler(job.args);
        if (!response.isError) {
          detectedRoot = getLastKnownProjectRoot();
        }
      } finally {
        closeAllDatabases();
      }

      return {
        ...response,
        ...(detectedRoot ? { projectRoot: detectedRoot } : {}),
      };
    })();

    try {
      return await Promise.race([executionPromise, timeoutPromise, abortPromise]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortListener && job.signal) {
        job.signal.removeEventListener('abort', abortListener);
      }
    }
  }
}
