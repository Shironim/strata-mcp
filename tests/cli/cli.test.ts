import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { main } from '../../src/cli';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('CLI Companion (Task 6 DoD)', () => {
  it('executes find-component-usage from CLI and outputs valid JSON', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['find-component-usage', 'OldButton', '--path', FIXTURES_DIR, '--json']);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(4);
  });

  it('executes search with simple pattern from CLI', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['search', 'defineProps<$$$>()', '--path', FIXTURES_DIR]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('NewButton.vue:6');
  });
});
