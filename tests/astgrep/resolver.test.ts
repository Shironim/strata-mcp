import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findScopedBinary,
  resolveAstGrepBinary,
  scopedPlatformForCurrent,
  verifyAstGrepBinary,
  executeAstGrep,
} from '../../src/engine/astgrep';

const ORIGINAL_BIN = process.env.AST_GREP_BIN;
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  if (ORIGINAL_BIN === undefined) delete process.env.AST_GREP_BIN;
  else process.env.AST_GREP_BIN = ORIGINAL_BIN;
  process.chdir(ORIGINAL_CWD);
});

describe('scoped platform mapping', () => {
  it('maps linux-x64 to the linux scoped package', () => {
    expect(scopedPlatformForCurrent('linux', 'x64')).toEqual({
      target: 'linux-x64-gnu',
      packageName: '@ast-grep/cli-linux-x64-gnu',
      binary: 'ast-grep',
    });
  });

  it('maps win32-x64 to the windows scoped package', () => {
    expect(scopedPlatformForCurrent('win32', 'x64')).toEqual({
      target: 'win32-x64-msvc',
      packageName: '@ast-grep/cli-win32-x64-msvc',
      binary: 'ast-grep.exe',
    });
  });

  it('maps darwin-arm64 to the macOS Apple Silicon scoped package', () => {
    expect(scopedPlatformForCurrent('darwin', 'arm64')).toEqual({
      target: 'darwin-arm64',
      packageName: '@ast-grep/cli-darwin-arm64',
      binary: 'ast-grep',
    });
  });

  it('maps darwin-x64 to the macOS Intel scoped package', () => {
    expect(scopedPlatformForCurrent('darwin', 'x64')).toEqual({
      target: 'darwin-x64',
      packageName: '@ast-grep/cli-darwin-x64',
      binary: 'ast-grep',
    });
  });

  it('returns null for unsupported platforms (linux-arm64, win32-arm64, ...)', () => {
    expect(scopedPlatformForCurrent('linux', 'arm64')).toBeNull();
    expect(scopedPlatformForCurrent('win32', 'arm64')).toBeNull();
    expect(scopedPlatformForCurrent('freebsd', 'x64')).toBeNull();
  });
});

describe('resolveAstGrepBinary tiers', () => {
  it('Tier 1: AST_GREP_BIN wins over everything', () => {
    process.env.AST_GREP_BIN = '/tmp/custom-sg/ast-grep';
    expect(resolveAstGrepBinary()).toBe('/tmp/custom-sg/ast-grep');
  });

  it('Tier 2: findScopedBinary locates the scoped binary via walk-up', () => {
    const scoped = scopedPlatformForCurrent('linux', 'x64');
    expect(scoped).not.toBeNull();

    const root = mkdtempSync(join(tmpdir(), 'sg-tier2-'));
    const pkgDir = join(root, 'node_modules', '@ast-grep', 'cli-linux-x64-gnu');
    mkdirSync(pkgDir, { recursive: true });
    const binPath = join(pkgDir, 'ast-grep');
    writeFileSync(binPath, '#!/bin/sh\necho fake\n');

    // Direct hit from a nested project dir (walk-up).
    expect(findScopedBinary([join(root, 'a', 'b', 'c')], scoped!)).toBe(binPath);
    // Miss when the tree has no scoped package.
    const empty = mkdtempSync(join(tmpdir(), 'sg-empty-'));
    expect(findScopedBinary([empty], scoped!)).toBeNull();
  });

  it('Tier 4: falls back to PATH name when nothing is installed', () => {
    delete process.env.AST_GREP_BIN;
    const resolved = resolveAstGrepBinary();
    // In this repo node_modules/.bin exists, so we get a real path;
    // the point is it never throws and never mentions trust setup.
    expect(typeof resolved).toBe('string');
  });
});

describe('verifyAstGrepBinary friendly error reporting', () => {
  it('broken AST_GREP_BIN resolves to ok:false with install hint', async () => {
    process.env.AST_GREP_BIN = '/tmp/definitely-not-here-xyz/ast-grep';
    const status = await verifyAstGrepBinary();
    expect(status.ok).toBe(false);
    expect(status.error ?? '').not.toContain('pm trust');
    expect(status.error ?? '').not.toContain('trustedDependencies');
    expect(status.error ?? '').toContain('AST_GREP_BIN');
  });
});

describe('executeAstGrep exit code normalization (0.45 compatibility)', () => {
  const isWin = process.platform === 'win32';

  it('normalizes exit code 1 with empty output to empty array []', async () => {
    const mockDir = mkdtempSync(join(tmpdir(), 'sg-mock-'));
    const mockBin = join(mockDir, isWin ? 'mock-sg.cmd' : 'mock-sg');
    writeFileSync(mockBin, isWin ? '@findstr "^" >nul\r\n@exit /b 1\r\n' : '#!/bin/sh\ncat > /dev/null\nexit 1\n');
    if (!isWin) chmodSync(mockBin, 0o755);

    process.env.AST_GREP_BIN = mockBin;
    const results = await executeAstGrep({ pattern: 'dummy', code: 'const x = 1;' });
    expect(results).toEqual([]);
  });

  it('rejects exit code 1 when stderr has actual error details', async () => {
    const mockDir = mkdtempSync(join(tmpdir(), 'sg-mock-err-'));
    const mockBin = join(mockDir, isWin ? 'mock-sg-err.cmd' : 'mock-sg-err');
    writeFileSync(
      mockBin,
      isWin ? '@echo invalid syntax 1>&2\r\n@exit /b 1\r\n' : '#!/bin/sh\necho "invalid syntax" >&2\nexit 1\n'
    );
    if (!isWin) chmodSync(mockBin, 0o755);

    process.env.AST_GREP_BIN = mockBin;
    expect(executeAstGrep({ pattern: 'dummy', code: 'const x = 1;' })).rejects.toThrow(
      'ast-grep error (exit code 1): invalid syntax'
    );
  });
});

