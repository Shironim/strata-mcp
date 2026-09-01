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

  it('supports command aliases: find, usage, and audit with -p flag', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['find', 'defineProps<$$$>()', '-p', FIXTURES_DIR]);
      await main(['usage', 'OldButton', '-p', FIXTURES_DIR, '--json']);
      await main(['audit', '--path', FIXTURES_DIR]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs[0]).toContain('NewButton.vue:6');
    const parsedUsage = JSON.parse(logs[1]);
    expect(Array.isArray(parsedUsage)).toBe(true);
    expect(logs[2]).toContain('Unused Components Audit');
  });

  it('executes routes command and tree with --direction upward from CLI', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['routes', FIXTURES_DIR]);
      await main([
        'tree',
        join(FIXTURES_DIR, 'OldButton.vue'),
        '--direction',
        'upward',
      ]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toContain('Route Manifest');
    expect(logs[1]).toContain('Upward Blast Radius');
  });

  it('executes impact and sync commands from CLI', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['impact', 'useRouter', '--path', FIXTURES_DIR]);
      await main(['sync', FIXTURES_DIR]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toContain('State Impact Analysis for: useRouter');
    expect(logs[1]).toContain('Synced workspace');
  });
});
