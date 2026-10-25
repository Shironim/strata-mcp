import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/database';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('CLI Companion (Task 6 DoD)', () => {
  beforeAll(() => { getWorkspaceDatabase(FIXTURES_DIR, { create: true }); });
  afterAll(() => { closeAllDatabases(); });
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

  it('executes audit with sub-targets and multi-hop impact from CLI', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['audit', '--path', FIXTURES_DIR, '--target', 'dead-state']);
      await main(['audit', '--path', FIXTURES_DIR, '--target', 'routes']);
      await main(['impact', 'useRouter', '--path', FIXTURES_DIR, '--depth', '2']);
      await main(['apis', FIXTURES_DIR, '--json']);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs[0]).toContain('Unused State');
    expect(logs[1]).toContain('Route Manifest');
    expect(logs[2]).toContain('State Dependency Chain');
    const parsedApis = JSON.parse(logs[3]);
    expect(parsedApis.workspaceRoot).toBeDefined();
  });

  it('executes init command from CLI with short flags -y and -f without hanging', async () => {
    const tmp = mkdtempSync('/tmp/strata-cli-init-');
    try {
      await main(['init', tmp, '-y', '-f']);
      expect(existsSync(join(tmp, '.strata', 'graph.db'))).toBe(true);
      expect(existsSync(join(tmp, '.agents', 'rules', 'strata-frontend.md'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('correctly parses boolean flags without consuming following positional argument', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // --audit-events must not eat the file path argument!
      await main(['contract', '--audit-events', join(FIXTURES_DIR, 'OldButton.vue')]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('Event Handler Audit');
  });

  it('supports unified and symmetrical command aliases: find --component, inspect, and trace', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await main(['find', '--component', 'OldButton', '-p', FIXTURES_DIR, '--json']);
      await main(['inspect', join(FIXTURES_DIR, 'OldButton.vue')]);
      await main(['trace', 'useRouter', '-p', FIXTURES_DIR]);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBeGreaterThanOrEqual(3);
    const parsedUsage = JSON.parse(logs[0]);
    expect(Array.isArray(parsedUsage)).toBe(true);
    expect(logs[1]).toContain('OldButton');
    expect(logs[2]).toContain('State Impact Analysis');
  });

  it('prints concise root help and command-specific contextual help without slop', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // 1. Root help with --help
      await main(['--help']);
      // 2. Command-specific help with <cmd> --help
      await main(['audit', '--help']);
      // 3. Command-specific help with help <cmd>
      await main(['help', 'patch']);
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBe(3);

    // Root help assertions
    const rootHelp = logs[0];
    expect(rootHelp).toContain('strata — Frontend Structural Code Search & Intelligence CLI');
    expect(rootHelp).toContain('Core Analytical Commands');
    expect(rootHelp).toContain('Direct Shortcuts');
    // Ensure root help is concise (< 40 lines) and has no lines exceeding 100 columns
    const rootLines = rootHelp.trim().split('\n');
    expect(rootLines.length).toBeLessThanOrEqual(40);
    for (const line of rootLines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }

    // Command-specific audit help assertions
    const auditHelp = logs[1];
    expect(auditHelp).toContain('Usage: strata audit [target-dir] [options]');
    expect(auditHelp).toContain('archetype-drift');
    expect(auditHelp).toContain('--exemplar <file>');

    // Command-specific patch help assertions
    const patchHelp = logs[2];
    expect(patchHelp).toContain('Usage: strata patch <component-file> [options]');
    expect(patchHelp).toContain('rename_prop');
    expect(patchHelp).toContain('--old <name>');
  });

  it('supports CLI workspace mapping and map-selected source slices', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    const file = join(FIXTURES_DIR, 'NewButton.vue');
    try {
      await main(['find', '--map', FIXTURES_DIR, '--json', '--limit', '1']);
      await main(['inspect', file, '--view', 'map', '--json']);
      await main(['find', 'defineProps', '--mode', 'literal', '--path', FIXTURES_DIR]);
    } finally {
      console.log = originalLog;
    }
    const inventory = JSON.parse(logs[0]);
    const fileMap = JSON.parse(logs[1]);
    expect(logs[2]).toContain('NewButton.vue');
    expect(inventory.coverage.returnedFiles).toBe(1);
    expect(fileMap.regions.length).toBeGreaterThan(0);
    const selected = fileMap.regions[0];
    const sliceLogs: string[] = [];
    console.log = (...args) => sliceLogs.push(args.join(' '));
    try {
      await main(['inspect', file, '--view', 'source', '--source-ref', JSON.stringify(selected.ref)]);
    } finally {
      console.log = originalLog;
    }
    expect(sliceLogs[0]).toBeTruthy();
  });
});

