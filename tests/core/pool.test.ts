import { describe, expect, it } from 'bun:test';
import { runConcurrent } from '../../src/engine/pool';

describe('Bounded Concurrency Pool (src/engine/pool.ts)', () => {
  it('preserves input ordering while running concurrently', async () => {
    const items = [10, 20, 30, 40, 50];

    const results = await runConcurrent(
      items,
      async (item, idx) => {
        // simulate variable latency
        await new Promise((r) => setTimeout(r, (5 - idx) * 2));
        return item * 2;
      },
      3
    );

    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it('handles empty input array gracefully', async () => {
    const results = await runConcurrent([], async (x) => x);
    expect(results).toEqual([]);
  });
});
