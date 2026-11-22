import { findTool } from './tools';
import { defaultWarmDbPool, defaultSemanticPool, defaultSyncCoordinator } from './engine/v2';
import {
  getLastKnownProjectRoot,
  runWithRequestProjectRoot,
  setLastKnownProjectRoot,
} from './engine/path-resolver';
import type { ToolCallResponse } from './tools/types';
import { withAnalysisContext, type ProgressReporter } from './engine/analysis-context';

export interface AnalysisResponse extends ToolCallResponse {
  projectRoot?: string;
}

export const ANALYSIS_LIMITS = {
  requestBytes: 2 * 1024 * 1024,
  queued: 16,
  timeoutMs: 120000,
  maxConcurrentFast: 4,
};

const FAST_GRAPH_QUERIES = new Set([
  'call_hierarchy',
  'callHierarchy',
  'component_tree',
  'componentTree',
  'state_flow',
  'stateFlow',
]);

export function isFastReadOnlyJob(name: string, args: Record<string, unknown>): boolean {
  if (name === 'map_workspace' || name === 'read_slice' || name === 'search_code') {
    return true;
  }
  if (name === 'inspect_file') {
    return args.resolve_types === false;
  }
  if (name === 'query_graph') {
    return typeof args.query === 'string' && FAST_GRAPH_QUERIES.has(args.query);
  }
  return false;
}

interface Job {
  name: string;
  args: Record<string, unknown>;
  isFast: boolean;
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
  private activeExclusive = false;
  private activeFastCount = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly limits: typeof ANALYSIS_LIMITS;
  private activeControllers = new Set<AbortController>();

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
    if ((this.activeExclusive || this.activeFastCount > 0) && this.queue.length >= this.limits.queued) {
      return Promise.reject(new Error(`SERVER_BUSY: ${this.limits.queued} analysis requests are already waiting`));
    }

    return new Promise((resolve, reject) => {
      const job: Job = {
        name,
        args,
        isFast: isFastReadOnlyJob(name, args),
        rootHint,
        signal,
        onProgress,
        resolve,
        reject,
      };
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
    for (const controller of this.activeControllers) {
      controller.abort(new Error('SERVER_CLOSED: analysis cancelled'));
    }
    for (const job of this.queue.splice(0)) {
      job.removeAbort?.();
      job.reject(new Error('SERVER_CLOSED: analysis cancelled'));
    }
    if (this.activeExclusive || this.activeFastCount > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    defaultSyncCoordinator.closeAll();
    defaultSemanticPool.disposeAll();
    defaultWarmDbPool.closeAll();
  }

  private next(): void {
    while (!this.closed && !this.activeExclusive && this.queue.length > 0) {
      const head = this.queue[0];
      if (head.isFast) {
        if (this.activeFastCount >= this.limits.maxConcurrentFast) break;
        this.queue.shift();
        this.activeFastCount++;
        this.launchJob(head);
      } else {
        if (this.activeFastCount > 0) break;
        this.queue.shift();
        this.activeExclusive = true;
        this.launchJob(head);
        break;
      }
    }
  }

  private launchJob(job: Job): void {
    void this.execute(job)
      .catch(job.reject)
      .finally(() => {
        job.removeAbort?.();
        if (job.isFast) {
          this.activeFastCount = Math.max(0, this.activeFastCount - 1);
        } else {
          this.activeExclusive = false;
        }
        if (!this.activeExclusive && this.activeFastCount === 0) {
          this.idleWaiters.splice(0).forEach((resolve) => resolve());
        }
        this.next();
      });
  }

  private async execute(job: Job): Promise<void> {
    if (job.signal?.aborted || this.closed) {
      throw new Error('REQUEST_CANCELLED: analysis cancelled');
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
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

    const effectiveRoot =
      job.rootHint ?? (typeof job.args.root === 'string' ? job.args.root : undefined);

    try {
      const response = await runWithRequestProjectRoot(effectiveRoot, () =>
        withAnalysisContext(async (): Promise<AnalysisResponse> => {
          if (job.rootHint) setLastKnownProjectRoot(job.rootHint);
          const tool = findTool(job.name);
          if (!tool) throw new Error(`UNKNOWN_TOOL: ${job.name}`);

          const response = await tool.handler(job.args);
          const detectedRoot = !response.isError ? getLastKnownProjectRoot() : undefined;

          return {
            ...response,
            ...(detectedRoot ? { projectRoot: detectedRoot } : {}),
          };
        }, controller.signal, job.onProgress)
      );
      if (!controller.signal.aborted) job.resolve(response);
    } finally {
      // The queue slot belongs to execution, even after its client response timed out.
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
      this.activeControllers.delete(controller);
    }
  }
}
