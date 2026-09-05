import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { RawMatch } from '../types';

/**
 * Universal cross-platform resolver for the current module's directory
 * Supporting Bun, Node ESM, CommonJS, and across Windows, Linux, and macOS.
 */
function getModuleDir(): string {
  if (typeof import.meta !== 'undefined') {
    const meta = import.meta as unknown as Record<string, unknown>;
    if (typeof meta.dir === 'string') return meta.dir;
    if (typeof meta.dirname === 'string') return meta.dirname;
    if (typeof meta.url === 'string') return dirname(fileURLToPath(meta.url));
  }
  if (typeof __dirname !== 'undefined') return __dirname;
  return process.cwd();
}

export interface AstGrepQueryOptions {
  pattern?: string;
  rule?: string; // Inline YAML or JSON string rule
  language?: string; // 'ts' | 'js' | 'tsx' | 'jsx' | 'html' | 'css'
  code?: string; // Content if matching from memory / stdin
  targetPath?: string; // File or directory path if scanning disk
  maxResults?: number;
}

export interface AstGrepItemOutput {
  text?: string;
  lines?: string;
  range?: {
    start: { line: number; column: number; index: number };
    end: { line: number; column: number; index: number };
  };
  file?: string;
}

/**
 * Scoped platform packages — prebuilt ast-grep binaries distributed via
 * optionalDependencies to avoid lifecycle script requirements.
 */
const AST_GREP_VERSION = '0.45.3';

interface ScopedPlatform {
  target: string;
  packageName: string;
  binary: string;
}

/** Scoped platform spec for the current host, or null if unsupported. */
export function scopedPlatformForCurrent(
  platform: string = process.platform,
  arch: string = process.arch
): ScopedPlatform | null {
  if (platform === 'linux' && arch === 'x64') {
    return {
      target: 'linux-x64-gnu',
      packageName: '@ast-grep/cli-linux-x64-gnu',
      binary: 'ast-grep',
    };
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      target: 'win32-x64-msvc',
      packageName: '@ast-grep/cli-win32-x64-msvc',
      binary: 'ast-grep.exe',
    };
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return {
        target: 'darwin-arm64',
        packageName: '@ast-grep/cli-darwin-arm64',
        binary: 'ast-grep',
      };
    }
    if (arch === 'x64') {
      return {
        target: 'darwin-x64',
        packageName: '@ast-grep/cli-darwin-x64',
        binary: 'ast-grep',
      };
    }
  }
  return null;
}

/** Resolves an installation hint tailored to the active platform. */
function installHint(): string {
  const scoped = scopedPlatformForCurrent();
  if (scoped) {
    return (
      `ast-grep binary not found. It should have been installed automatically via ` +
      `optionalDependencies ("${scoped.packageName}@${AST_GREP_VERSION}"). Try reinstalling dependencies, ` +
      `or set AST_GREP_BIN to a working ast-grep binary.`
    );
  }
  return (
    `ast-grep binary not found. This platform (${process.platform}-${process.arch}) has no bundled binary; ` +
    `install ast-grep manually (download from https://ast-grep.github.io/) and set AST_GREP_BIN to its path, ` +
    `or put ast-grep on your PATH.`
  );
}

/**
 * Direct file lookup for the scoped platform binary, walking up from each
 * root dir. Extracted for testability — resolveAstGrepBinary() calls it with
 * [getModuleDir(), process.cwd()].
 */
export function findScopedBinary(rootDirs: string[], scoped: ScopedPlatform): string | null {
  const [scope, pkg] = scoped.packageName.split('/');
  for (const root of rootDirs) {
    let d = root;
    while (d && d !== dirname(d)) {
      const fullPath = join(d, 'node_modules', scope, pkg, scoped.binary);
      if (existsSync(fullPath)) return fullPath;
      d = dirname(d);
    }
  }
  return null;
}

/**
 * Detects the ast-grep binary location.
 * Search priority:
 * 1. AST_GREP_BIN environment variable
 * 2. Scoped platform package (@ast-grep/cli-<target>)
 * 3. Legacy: node_modules/.bin + upstream @ast-grep/cli-* package files
 * 4. System PATH fallback
 */
export function resolveAstGrepBinary(): string {
  if (process.env.AST_GREP_BIN && process.env.AST_GREP_BIN.trim()) {
    return process.env.AST_GREP_BIN;
  }

  const isWin = process.platform === 'win32';

  // Tier 2: scoped platform package
  const scoped = scopedPlatformForCurrent();
  if (scoped) {
    const hit = findScopedBinary([getModuleDir(), process.cwd()], scoped);
    if (hit) return hit;
  }
  const candidateNames = isWin
    ? ['ast-grep.exe', 'ast-grep.cmd', 'ast-grep', 'sg.exe', 'sg.cmd', 'sg']
    : ['ast-grep', 'sg', 'ast-grep.exe'];

  const directPackageCandidates = isWin
    ? [
        join('@ast-grep', 'cli', 'ast-grep.exe'),
        join('@ast-grep', 'cli-win32-x64-msvc', 'ast-grep.exe'),
      ]
    : [
        join('@ast-grep', 'cli', 'ast-grep'),
        join('@ast-grep', 'cli-linux-x64-gnu', 'ast-grep'),
        join('@ast-grep', 'cli-darwin-arm64', 'ast-grep'),
        join('@ast-grep', 'cli-darwin-x64', 'ast-grep'),
      ];

  function searchDirectory(baseDir: string): string | null {
    let dir = baseDir;
    while (dir && dir !== dirname(dir)) {
      const binDir = join(dir, 'node_modules', '.bin');
      for (const candidate of candidateNames) {
        const fullPath = join(binDir, candidate);
        if (existsSync(fullPath)) return fullPath;
      }

      for (const relPkg of directPackageCandidates) {
        const fullPath = join(dir, 'node_modules', relPkg);
        if (existsSync(fullPath)) return fullPath;
      }

      dir = dirname(dir);
    }
    return null;
  }

  // Tier 3a. Search walking up from current module file location
  const moduleMatch = searchDirectory(getModuleDir());
  if (moduleMatch) return moduleMatch;

  // Tier 3b. Search walking up from current working directory
  const cwdMatch = searchDirectory(process.cwd());
  if (cwdMatch) return cwdMatch;

  // Tier 4: fallback to system PATH (graceful degradation handled by verify/execute)
  return isWin ? 'ast-grep.exe' : 'ast-grep';
}

/**
 * Checks if the ast-grep binary can be executed.
 */
export async function verifyAstGrepBinary(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');

  // NOTE: spawn() can throw synchronously (e.g. ENOEXEC on a dangling
  // node_modules/.bin symlink when a postinstall binary was blocked).
  // That must resolve to { ok: false } — never reject —
  // otherwise runServer() crashes on startup and MCP clients report -32000.
  try {
    return await new Promise<{ ok: boolean; path?: string; error?: string }>((resolve) => {
      let proc;
      try {
        proc = spawn(bin, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: isCmd,
        });
      } catch (err) {
        resolve({
          ok: false,
          error: `ast-grep binary was not found or failed to start: ${err instanceof Error ? err.message : String(err)}. ${installHint()}`,
        });
        return;
      }

      proc.on('error', (err) => {
        resolve({
          ok: false,
          error: `ast-grep binary was not found or failed to start: ${err.message}. ${installHint()}`,
        });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, path: bin });
        } else {
          resolve({
            ok: false,
            error: `ast-grep exited with code ${code}. ${installHint()}`,
          });
        }
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: `ast-grep binary check failed: ${err instanceof Error ? err.message : String(err)}. ${installHint()}`,
    };
  }
}

/**
 * Checks if an error is caused by a missing, non-executable, or failed ast-grep binary (fatal error)
 * as opposed to an in-file syntax/parse failure.
 */
export function isBinaryExecutionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Failed to execute ast-grep') ||
    msg.includes('ENOENT') ||
    msg.includes('EACCES') ||
    msg.includes('ast-grep binary not found') ||
    msg.includes('Make sure @ast-grep/cli is installed')
  );
}

/**
 * Executes an ast-grep query either on an in-memory string (via stdin) or against file paths on disk.
 */
export async function executeAstGrep(options: AstGrepQueryOptions): Promise<RawMatch[]> {
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');
  let lang = options.language || 'ts';
  if (lang === 'vue' || lang === 'astro' || lang === 'auto') {
    const checkText = options.pattern || options.code || '';
    if (/^\s*<[A-Za-z0-9_$-]/.test(checkText) || checkText.includes('</') || checkText.endsWith('/>')) {
      lang = 'html';
    } else {
      lang = 'ts';
    }
  }
  const isRule = Boolean(options.rule);

  const args: string[] = isRule ? ['scan'] : ['run'];
  let tempRuleFile: string | null = null;

  if (options.rule) {
    tempRuleFile = join(tmpdir(), `sg-rule-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
    await fs.writeFile(tempRuleFile, options.rule, 'utf8');
    args.push('--rule', tempRuleFile);
  } else if (options.pattern) {
    args.push('--pattern', options.pattern);
  }

  if (!isRule) {
    args.push('--lang', lang);
  }

  args.push('--json=stream');

  const useStdin = options.code !== undefined;
  if (useStdin) {
    args.push('--stdin');
  } else if (options.targetPath) {
    args.push(options.targetPath);
  }

  try {
    return await new Promise<RawMatch[]>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      let proc;
      try {
        proc = spawn(bin, args, {
          stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          shell: isCmd,
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to execute ast-grep at "${bin}": ${err instanceof Error ? err.message : String(err)}. ${installHint()}`
          )
        );
        return;
      }

      if (useStdin && proc.stdin) {
        proc.stdin.on('error', () => {});
        proc.stdin.write(options.code);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        reject(
          new Error(
            `Failed to execute ast-grep at "${bin}": ${err.message}. ${installHint()}`
          )
        );
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim();
          // Compat: ast-grep >= 0.4x uses grep-like exit codes for `run` —
          // exit 1 with empty stdout/stderr means "no matches found".
          // 0.38 exits 0 in that case. Normalize both to an empty result
          // instead of throwing, so callers (batch fallback, findCode,
          // CLI) see zero matches rather than a fatal error.
          if (code === 1 && stdout.trim() === '' && detail === '') {
            resolve([]);
            return;
          }
          let errorMsg = `ast-grep error (exit code ${code}): ${detail || `process exited with code ${code}`}`;
          if (stderr.includes('mapping values are not allowed')) {
            errorMsg += '\nHint: wrap your pattern with quotes (e.g. pattern: "$NAME?: $$$") when using special characters like ?, :, {, }.';
          }
          if (stderr.includes('missing field') && stderr.includes('id')) {
            errorMsg += '\nHint: add an "id:" field to your rule YAML (e.g. id: my-rule).';
          }
          reject(new Error(errorMsg));
          return;
        }

        const matches: RawMatch[] = [];
        const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as AstGrepItemOutput;
            if (parsed.range) {
              matches.push({
                line: parsed.range.start.line + 1,
                column: parsed.range.start.column + 1,
                endLine: parsed.range.end.line + 1,
                endColumn: parsed.range.end.column + 1,
                text: parsed.text || parsed.lines || '',
              });
            }
          } catch {
            try {
              const arr = JSON.parse(stdout) as AstGrepItemOutput[];
              for (const item of arr) {
                if (item.range) {
                  matches.push({
                    line: item.range.start.line + 1,
                    column: item.range.start.column + 1,
                    endLine: item.range.end.line + 1,
                    endColumn: item.range.end.column + 1,
                    text: item.text || item.lines || '',
                  });
                }
              }
              break;
            } catch {
              // Ignore non-json
            }
          }
        }

        if (options.maxResults && options.maxResults > 0) {
          resolve(matches.slice(0, options.maxResults));
        } else {
          resolve(matches);
        }
      });
    });
  } finally {
    if (tempRuleFile) {
      await fs.unlink(tempRuleFile).catch(() => {});
    }
  }
}

/**
 * Dumps the CST of a code snippet.
 */
export async function dumpSyntaxTree(code: string, language: string = 'ts'): Promise<string> {
  let lang = language;
  if (lang === 'vue' || lang === 'astro' || lang === 'auto') {
    lang = (/^\s*<[A-Za-z0-9_$-]/.test(code) || code.includes('</') || code.endsWith('/>')) ? 'html' : 'ts';
  }
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');
  const args = ['run', '--pattern', code, '--lang', lang, '--debug-query=cst', '--stdin'];

  return new Promise((resolve, reject) => {
    let stderr = '';

    let proc;
    try {
      proc = spawn(bin, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        shell: isCmd,
      });
    } catch (err) {
      reject(
        new Error(
            `Failed to dump syntax tree: ${err instanceof Error ? err.message : String(err)}. ${installHint()}`
        )
      );
      return;
    }

    // Immediately close stdin to prevent ast-grep from scanning the working directory
    proc.stdin?.on('error', () => {});
    proc.stdin?.end();

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to dump syntax tree: ${err.message}`));
    });

    proc.on('close', (code) => {
      const output = stderr.trim();
      // Compat: ast-grep >= 0.4x exits 1 for --debug-query (no JSON matches
      // are produced) while still printing the CST to stderr; 0.38 exits 0
      // with identical output. Accept either as long as debug output exists.
      if (/^debug \w+:/im.test(output)) {
        resolve(output);
        return;
      }
      if (code !== 0) {
        reject(new Error(`ast-grep dump failed (exit ${code}): ${output || 'unknown error'}`));
        return;
      }
      resolve(output);
    });
  });
}
