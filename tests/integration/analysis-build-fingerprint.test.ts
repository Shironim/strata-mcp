import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import type { SyncStats } from '../../src/types';

const repo = resolve(import.meta.dir, '../..');

async function run(cwd: string, command: string[]) {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function success(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} exited ${result.exitCode}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

test('builds with the same semver refresh changed edges once and keep failed fingerprints unpublished', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'strata-analysis-build-'));
  const checkout = join(temp, 'checkout');
  const workspace = join(temp, 'workspace');
  const app = join(workspace, 'Parent.vue');
  const appSource = '<template><Card title="ready" /></template>';
  const bun = process.execPath;
  try {
    await mkdir(checkout);
    await mkdir(workspace);
    for (const entry of ['src', 'bin', 'scripts', 'package.json']) {
      await cp(join(repo, entry), join(checkout, entry), { recursive: true });
    }
    await symlink(join(repo, 'node_modules'), join(checkout, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(workspace, 'package.json'), '{"dependencies":{"nuxt":"3"}}');
    await writeFile(join(workspace, 'Card.vue'), '<template><p /></template>');
    await writeFile(app, appSource);
    getWorkspaceDatabase(workspace, { create: true });
    closeWorkspaceDatabase(workspace);

    const componentParser = join(checkout, 'src/engine/graph/component-relationships.ts');
    const parserSource = await readFile(componentParser, 'utf8');
    const parserChange = parserSource.replace('return [...(catalog.get(tag.toLowerCase()) ?? [])]', 'return [...(catalog.get(tag) ?? [])]');
    expect(parserChange).not.toBe(parserSource);
    await writeFile(componentParser, parserChange);
    await success(checkout, [bun, 'run', 'build', '--outdir', 'build-a']);
    const sync = async (runner: string[]): Promise<SyncStats> =>
      JSON.parse(await success(checkout, [...runner, 'sync', workspace, '--json']));
    const a = [bun, 'build-a/cli.js'];
    const initial = await sync(a);
    const legacy = new Database(join(workspace, '.strata/graph.db'));
    try { legacy.run("DELETE FROM meta WHERE key='analysis_fingerprint'"); }
    finally { legacy.close(); }
    const first = await sync(a);
    expect(first.analysisFingerprint).toBe(initial.analysisFingerprint);
    expect(first.syncGeneration).toBe(initial.syncGeneration + 1);
    expect(first.parserInvocations).toBe(2);
    expect(await sync(a)).toMatchObject({ cacheHit: true, parserInvocations: 0 });
    expect(first.analysisFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const inspect = () => {
      const db = new Database(join(workspace, '.strata/graph.db'), { readonly: true });
      try {
        const meta = Object.fromEntries(db.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all()
          .map(row => [row.key, row.value]));
        const edges = db.query('SELECT import_type FROM edges ORDER BY id').all();
        return { meta, edges };
      } finally { db.close(); }
    };
    const original = inspect();
    expect(original.edges).toEqual([]);
    expect(original.meta.analysis_fingerprint).toBe(first.analysisFingerprint);

    await writeFile(componentParser, parserSource);
    await success(checkout, [bun, 'run', 'build', '--outdir', 'build-b']);
    const b = [bun, 'build-b/cli.js'];
    const refreshed = await sync(b);
    expect(refreshed.analysisFingerprint).not.toBe(first.analysisFingerprint);
    expect(refreshed.configFingerprint).toBe(first.configFingerprint);
    expect(refreshed.syncGeneration).toBe(first.syncGeneration + 1);
    expect(refreshed.parserInvocations).toBe(2);
    const upgraded = inspect();
    expect(upgraded.meta.cache_version).toBe(original.meta.cache_version);
    expect(upgraded.edges).toEqual([{ import_type: 'auto' }]);
    const assertWarm = (stats: SyncStats) => {
      expect(stats.analysisFingerprint).toBe(refreshed.analysisFingerprint);
      expect(stats.syncGeneration).toBe(refreshed.syncGeneration);
      expect(stats.cacheHit).toBe(true);
      expect(stats.parserInvocations).toBe(0);
    };
    assertWarm(await sync(b));
    assertWarm(await sync([bun, 'src/cli.ts']));
    if (process.platform === 'linux' && process.arch === 'x64') {
      await success(checkout, [bun, 'run', 'compile:all', 'bun-linux-x64']);
      assertWarm(await sync([join(checkout, 'dist/strata-linux-x64')]));
    }

    const manifestPath = join(checkout, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.8.7' }));
    const helpPath = join(checkout, 'src/cli/help.ts');
    await writeFile(helpPath, (await readFile(helpPath, 'utf8')) + '\n// Fixture-only help edit.\n');
    await writeFile(join(checkout, 'README.md'), '# Fixture documentation\n');
    await success(checkout, [bun, 'run', 'build', '--outdir', 'build-c']);
    const c = [bun, 'build-c/cli.js'];
    assertWarm(await sync(c));
    expect(inspect().meta.cache_version).toBe(original.meta.cache_version);

    await writeFile(join(workspace, 'base.json'), '{"compilerOptions":{"paths":{"@card":["./Card.vue"]}}}');
    await writeFile(join(workspace, 'tsconfig.json'), '{"extends":"./base.json"}');
    const config = await sync(c);
    expect(config.cacheHit).toBe(false);
    expect(config.analysisFingerprint).toBe(refreshed.analysisFingerprint);
    expect(config.configFingerprint).not.toBe(refreshed.configFingerprint);
    await writeFile(join(workspace, 'base.json'), '{"compilerOptions":{"paths":{"@card":["./Other.vue"]}}}');
    const extended = await sync(c);
    expect(extended.analysisFingerprint).toBe(config.analysisFingerprint);
    expect(extended.configFingerprint).not.toBe(config.configFingerprint);
    expect(extended.cacheHit).toBe(false);

    // Run the built artifact without a checkout, then simulate a failing analysis change.
    await rm(join(checkout, 'src'), { recursive: true });
    expect(await sync(c)).toMatchObject({ analysisFingerprint: refreshed.analysisFingerprint, cacheHit: true });
    await writeFile(app, '<template><div></template>');
    const failed = await run(checkout, [...a, 'sync', workspace, '--json']);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain('PARSE_FAILED');
    const invalid = inspect();
    expect(invalid.meta.analysis_fingerprint).toBe(refreshed.analysisFingerprint);
    expect(invalid.meta.sync_generation).toBe(String(extended.syncGeneration));
    expect(invalid.meta.index_invalid).toBe('1');

    await writeFile(app, appSource);
    const recovered = await sync(a);
    expect(recovered.analysisFingerprint).toBe(first.analysisFingerprint);
    expect(recovered.syncGeneration).toBe(extended.syncGeneration + 1);
    expect(inspect().edges).toEqual([]);
    expect(await sync(a)).toMatchObject({ cacheHit: true, parserInvocations: 0 });
  } finally {
    closeWorkspaceDatabase(workspace);
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
