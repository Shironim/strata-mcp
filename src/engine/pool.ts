import { cpus } from 'node:os';

export const DEFAULT_CONCURRENCY = Math.max(2, Math.min(cpus().length || 4, 8));

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

  async function poolWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const poolSize = Math.min(concurrency, items.length);
  const workers = Array.from({ length: poolSize }, () => poolWorker());

  await Promise.all(workers);
  return results;
}
