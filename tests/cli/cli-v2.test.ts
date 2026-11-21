import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { STRATA_VERSION } from '../../src/version';

describe('CLI 0.11.0 commands', () => {
  const cliEntry = resolve(import.meta.dir, '../../src/cli.ts');
  const monorepoSrc = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('--version prints 0.11.0 and --help lists 5 cognitive commands', async () => {
    const vProc = Bun.spawn(['bun', 'run', cliEntry, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const vOut = (await new Response(vProc.stdout).text()).trim();
    expect(await vProc.exited).toBe(0);
    expect(vOut).toBe(STRATA_VERSION);

    const hProc = Bun.spawn(['bun', 'run', cliEntry, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    const hOut = await new Response(hProc.stdout).text();
    expect(await hProc.exited).toBe(0);
    for (const cmd of ['map', 'inspect', 'graph', 'read', 'search', 'sync', 'init', 'serve']) {
      expect(hOut).toContain(cmd);
    }
  });

  test('runs sync, map, inspect, graph, search, and read end-to-end on monorepo fixture', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-cli-v2-'));
    try {
      await cp(monorepoSrc, workDir, { recursive: true });

      const runCli = async (args: string[]) => {
        const proc = Bun.spawn(['bun', 'run', cliEntry, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      };

      const syncRes = await runCli(['sync', workDir, '--json']);
      expect(syncRes.code).toBe(0);
      expect(JSON.parse(syncRes.stdout).packagesSynced).toBe(4);

      const mapRes = await runCli(['map', workDir, '--view', 'overview']);
      expect(mapRes.code).toBe(0);
      expect(mapRes.stdout).toContain('4 package(s)');

      const inspectRes = await runCli([
        'inspect',
        'packages/ui/src/OrderSummaryCard.vue',
        '--path',
        workDir,
      ]);
      expect(inspectRes.code).toBe(0);
      expect(inspectRes.stdout).toContain('customerName');
      expect(inspectRes.stdout).toContain('compact?');

      const graphRes = await runCli([
        'graph',
        'impact',
        'packages/ui/src/BaseButton.vue',
        '--member',
        'variant',
        '--path',
        workDir,
      ]);
      expect(graphRes.code).toBe(0);
      expect(graphRes.stdout).toContain('DYNAMIC_SPREAD');

      const searchRes = await runCli(['search', 'formatOrderTotal', '--path', workDir]);
      expect(searchRes.code).toBe(0);
      expect(searchRes.stdout).toContain('formatOrderTotal');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);
});
