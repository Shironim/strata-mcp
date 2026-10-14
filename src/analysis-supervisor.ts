import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallResponse } from './tools/types';

export interface AnalysisResponse extends ToolCallResponse {
  projectRoot?: string;
}

export const ANALYSIS_LIMITS = {
  requestBytes: 2 * 1024 * 1024, responseBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024, queued: 4, timeoutMs: 120000,
  sampleMs: 50, combinedBytes: 448 * 1024 * 1024, analysisBytes: 384 * 1024 * 1024,
};

interface Job {
  input: string; signal?: AbortSignal; resolve: (response: AnalysisResponse) => void;
  reject: (error: Error) => void; cancel?: () => void; removeAbort?: () => void;
}

export interface SupervisorOptions {
  workerPath?: string;
  limits?: Partial<typeof ANALYSIS_LIMITS>;
}

/** Linux process-group accounting includes native ast-grep descendants. */
export function analysisGroupRss(group: number): number {
  let bytes = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== group) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      bytes += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  return bytes;
}

export class AnalysisSupervisor {
  private queue: Job[] = [];
  private active?: Job;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly limits: typeof ANALYSIS_LIMITS;
  private readonly workerPath: string;

  constructor(options: SupervisorOptions = {}) {
    this.limits = { ...ANALYSIS_LIMITS, ...options.limits };
    const modulePath = fileURLToPath(import.meta.url);
    this.workerPath = options.workerPath ?? join(dirname(modulePath), modulePath.endsWith('.ts') ? 'analysis-worker.ts' : 'analysis-worker.js');
  }

  run(name: string, args: Record<string, unknown>, rootHint?: string, signal?: AbortSignal): Promise<AnalysisResponse> {
    if (this.closed) return Promise.reject(new Error('SERVER_CLOSED: analysis supervisor is closed'));
    if (signal?.aborted) return Promise.reject(new Error('REQUEST_CANCELLED: analysis cancelled'));
    // Check the serialized request before retaining it in the queue.
    const input = JSON.stringify({ name, args, rootHint });
    if (Buffer.byteLength(input) > this.limits.requestBytes) return Promise.reject(new Error('REQUEST_TOO_LARGE: maximum request is 2 MiB'));
    if (this.active && this.queue.length >= this.limits.queued) return Promise.reject(new Error('SERVER_BUSY: four analysis requests are already waiting'));
    return new Promise((resolve, reject) => {
      const job: Job = { input, signal, resolve, reject };
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) { this.queue.splice(index, 1); job.removeAbort?.(); reject(new Error('REQUEST_CANCELLED: queued analysis cancelled')); }
        else job.cancel?.();
      };
      signal?.addEventListener('abort', abort, { once: true });
      job.removeAbort = () => signal?.removeEventListener('abort', abort);
      this.queue.push(job); this.next();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) { job.removeAbort?.(); job.reject(new Error('SERVER_CLOSED: analysis cancelled')); }
    this.active?.cancel?.();
    if (this.active) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  private next(): void {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void this.execute(job).then(job.resolve, job.reject).finally(() => {
      job.removeAbort?.(); job.cancel = undefined; job.input = '';
      this.active = undefined;
      this.idleWaiters.splice(0).forEach(resolve => resolve());
      this.next();
    });
  }

  private async execute(job: Job): Promise<AnalysisResponse> {
    const workDir = mkdtempSync(join(tmpdir(), 'strata-analysis-'));
    let fd: number | undefined;
    try {
      const inputPath = join(workDir, 'request.json');
      const outputPath = join(workDir, 'response.json');
      writeFileSync(inputPath, job.input, { mode: 0o600 });
      fd = openSync(inputPath, 'r');
      return await new Promise<AnalysisResponse>((resolve, reject) => {
        const child = spawn(process.execPath, [this.workerPath, outputPath], {
          stdio: [fd!, 'pipe', 'pipe'], detached: process.platform !== 'win32',
          env: { ...process.env, TMPDIR: workDir, TMP: workDir, TEMP: workDir },
        });
        const chunks: Buffer[] = [];
        let bytes = 0, stderr = Buffer.alloc(0), failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
        };
        const stop = (error: Error) => {
          if (failure) return;
          failure = error; kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 250);
        };
        job.cancel = () => stop(new Error('REQUEST_CANCELLED: analysis cancelled'));
        if (job.signal?.aborted || this.closed) job.cancel();
        const timeout = setTimeout(() => stop(new Error('ANALYSIS_TIMEOUT: maximum analysis duration is 120 seconds')), this.limits.timeoutMs);
        const monitor = process.platform === 'linux' ? setInterval(() => {
          try {
            const rss = child.pid ? analysisGroupRss(child.pid) : 0;
            if (rss > this.limits.analysisBytes || rss + process.memoryUsage().rss > this.limits.combinedBytes) stop(new Error('MEMORY_LIMIT_EXCEEDED: analysis exceeded the 512 MiB memory profile'));
          } catch (err) { stop(new Error(`MEMORY_MONITOR_FAILED: ${String(err)}`)); }
        }, this.limits.sampleMs) : undefined;
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.limits.responseBytes) stop(new Error('RESPONSE_TOO_LARGE: maximum response is 8 MiB'));
          else if (!failure) chunks.push(chunk);
        });
        child.stderr!.on('data', (chunk: Buffer) => {
          const tail = chunk.subarray(Math.max(0, chunk.length - this.limits.stderrBytes));
          stderr = Buffer.concat([stderr, tail]).subarray(-this.limits.stderrBytes);
        });
        child.on('error', error => { failure ??= error; });
        child.on('exit', () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 250); });
        child.on('close', code => {
          clearTimeout(timeout); if (monitor) clearInterval(monitor); if (killTimer) clearTimeout(killTimer);
          kill('SIGKILL'); job.cancel = undefined;
          try {
            if (failure) throw failure;
            if (code !== 0) throw new Error(`ANALYSIS_FAILED: worker exited ${code}: ${stderr.toString('utf8').slice(-1024)}`);
            if (statSync(outputPath).size > this.limits.responseBytes) throw new Error('RESPONSE_TOO_LARGE: maximum response is 8 MiB');
            const response = JSON.parse(readFileSync(outputPath, 'utf8')) as AnalysisResponse;
            if (!Array.isArray(response?.content) || !response.content.every(item => item.type === 'text' && typeof item.text === 'string')) throw new Error('ANALYSIS_FAILED: invalid worker response');
            resolve(response);
          } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
          finally { chunks.length = 0; stderr = Buffer.alloc(0); }
        });
      });
    } finally { if (fd !== undefined) closeSync(fd); rmSync(workDir, { recursive: true, force: true }); }
  }
}
