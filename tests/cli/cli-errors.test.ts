import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { main } from '../../src/cli';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`Process exited with code ${code}`);
    this.code = code;
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  console.log = (...a: any[]) => stdout.push(a.join(' '));
  console.error = (...a: any[]) => stderr.push(a.join(' '));
  let exitCode = 0;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitError(exitCode);
  }) as any;

  try {
    await main(args);
  } catch (err) {
    if (!(err instanceof ExitError)) {
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { exitCode, stdout, stderr };
}

describe('CLI Commands Unhappy Paths & Edge Cases Suite', () => {
  it('exits with 1 when an unknown subcommand is invoked', async () => {
    const { exitCode, stderr } = await runCli(['non-existent-subcommand']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown command: "non-existent-subcommand"');
  });

  it('exits with 1 when strata find is invoked with no pattern', async () => {
    const { exitCode, stderr } = await runCli(['find']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Pattern is required for search command');
  });

  it('exits with 1 when strata inspect is invoked without target file argument', async () => {
    const { exitCode, stderr } = await runCli(['inspect']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Component file path is required');
  });

  it('exits with 1 when strata inspect is invoked with a directory instead of a file', async () => {
    const { exitCode, stderr } = await runCli(['inspect', FIXTURES_DIR]);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('is a directory');
  });

  it('exits with 1 when strata inspect target file does not exist', async () => {
    const { exitCode, stderr } = await runCli(['inspect', join(FIXTURES_DIR, 'GhostButton.vue')]);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('File not found');
  });

  it('exits with 1 safely when --view source receives malformed JSON --source-ref', async () => {
    const { exitCode, stderr } = await runCli([
      'inspect',
      join(FIXTURES_DIR, 'NewButton.vue'),
      '--view',
      'source',
      '--source-ref',
      '{bad-json',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Invalid JSON for --source-ref');
  });

  it('exits with 1 when strata tree is invoked without file argument or --route flag', async () => {
    const { exitCode, stderr } = await runCli(['tree']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Either an entry file path or --route <path> is required');
  });

  it('exits with 1 when strata trace is invoked without state identifier', async () => {
    const { exitCode, stderr } = await runCli(['trace']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('State identifier (store, context, composable) is required');
  });

  it('exits with 1 when strata audit is invoked with an unsupported target enum', async () => {
    const { exitCode, stderr } = await runCli(['audit', FIXTURES_DIR, '--target', 'invalid-target-xyz']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Invalid audit target');
  });

  it('exits with 1 when strata patch is invoked without component file argument', async () => {
    const { exitCode, stderr } = await runCli(['patch']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Component file path is required for patch-plan');
  });

  it('exits with 1 when strata patch is invoked with missing new name on rename_prop', async () => {
    const { exitCode, stderr } = await runCli([
      'patch',
      join(FIXTURES_DIR, 'NewButton.vue'),
      '--type',
      'rename_prop',
      '--old',
      'variant',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('--new <name>');
  });
});
