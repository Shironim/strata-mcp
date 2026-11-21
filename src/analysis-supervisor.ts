import { findTool } from './tools';
import { closeAllDatabases } from './engine/storage/schema';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from './engine/path-resolver';
import type { ToolCallResponse } from './tools/types';
import { withAnalysisContext, type ProgressReporter } from './engine/analysis-context';

export interface AnalysisResponse extends ToolCallResponse {
  projectRoot?: string;
}

export const ANALYSIS_LIMITS = {
  requestBytes: 2 * 1024 * 1024,
  queued: 4,
  timeoutMs: 120000,
};

interface Job {
  name: string;
  args: Record<string, unknown>;
  rootHint?: string;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  resolve: (response: AnalysisResponse) => void;
  reject: (error: Error) => void;
  removeAbort?: () => void;
}

export interface SupervisorOptions {
  limits?: Partial<typeof ANALYSIS_LIMITS>;
}

export class AnalysisSupervisor {
  private queue: Job[] = [];
  private active?: Job;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly limits: typeof ANALYSIS_LIMITS;
  private activeController?: AbortController;

  constructor(options: SupervisorOptions = {}) {
    this.limits = { ...ANALYSIS_LIMITS, ...options.limits };
  }

  run(
    name: string,
    args: Record<string, unknown>,
    rootHint?: string,
    signal?: AbortSignal,
    onProgress?: ProgressReporter
  ): Promise<AnalysisResponse> {
    if (this.closed) return Promise.reject(new Error('SERVER_CLOSED: analysis supervisor is closed'));
    if (signal?.aborted) return Promise.reject(new Error('REQUEST_CANCELLED: analysis cancelled'));

    const input = JSON.stringify({ name, args, rootHint });
    if (Buffer.byteLength(input) > this.limits.requestBytes) {
      return Promise.reject(new Error(`REQUEST_TOO_LARGE: maximum request is ${this.limits.requestBytes} bytes`));
    }
    if (this.active && this.queue.length >= this.limits.queued) {
      return Promise.reject(new Error(`SERVER_BUSY: ${this.limits.queued} analysis requests are already waiting`));
    }

    return new Promise((resolve, reject) => {
      const job: Job = { name, args, rootHint, signal, onProgress, resolve, reject };
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
    this.activeController?.abort(new Error('SERVER_CLOSED: analysis cancelled'));
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
      .catch(job.reject)
      .finally(() => {
        job.removeAbort?.();
        this.active = undefined;
        this.idleWaiters.splice(0).forEach((resolve) => resolve());
        this.next();
      });
  }

  private async execute(job: Job): Promise<void> {
    if (job.signal?.aborted || this.closed) {
      throw new Error('REQUEST_CANCELLED: analysis cancelled');
    }

    const controller = new AbortController();
    this.activeController = controller;
    const cancel = () => {
      const reason = controller.signal.reason;
      job.reject(reason instanceof Error ? reason : new Error('REQUEST_CANCELLED: analysis cancelled'));
    };
    const abort = () => controller.abort(new Error('REQUEST_CANCELLED: analysis cancelled'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    job.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(
      new Error(`ANALYSIS_TIMEOUT: maximum analysis duration is ${this.limits.timeoutMs / 1000} seconds`)
    ), this.limits.timeoutMs);

    try {
      const response = await withAnalysisContext(async (): Promise<AnalysisResponse> => {
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
      }, controller.signal, job.onProgress);
      if (!controller.signal.aborted) job.resolve(response);
    } finally {
      // The queue slot belongs to execution, even after its client response timed out.
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
      this.activeController = undefined;
    }
  }
}
