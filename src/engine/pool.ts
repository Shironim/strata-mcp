import { checkAnalysisCancelled } from './analysis-context';

export const DEFAULT_CONCURRENCY = 1;

/**
 * Executes an asynchronous worker over an array of items with bounded concurrency.
 * Preserves the original item order in the returned results array.
 */
export async function runConcurrent<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let hasFailed = false;

  async function poolWorker(): Promise<void> {
    while (nextIndex < items.length && !hasFailed) {
      checkAnalysisCancelled();
      const idx = nextIndex++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (error) { hasFailed = true; throw error; }
    }
  }

  const poolSize = Math.min(Math.max(1, Math.floor(concurrency) || DEFAULT_CONCURRENCY), items.length);
  const workers = Array.from({ length: poolSize }, () => poolWorker());

  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

/** Batches preserve file order and stop admitting work once enough matches are available. */
export async function collectConcurrentMatches<T, R>(
  items: T[], worker: (item: T) => Promise<R[]>, limit: number, concurrency = DEFAULT_CONCURRENCY
): Promise<R[]> {
  const width = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : DEFAULT_CONCURRENCY;
  const matches: R[] = [];
  for (let offset = 0; offset < items.length && matches.length < limit; offset += width) {
    const batch = await runConcurrent(items.slice(offset, offset + width), worker, width);
    for (const result of batch) matches.push(...result.slice(0, limit - matches.length));
  }
  return matches;
}
