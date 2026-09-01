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
 * Detects the ast-grep binary location.
 * Search priority:
 * 1. AST_GREP_BIN environment variable
 * 2. Package-local node_modules/.bin (resolved relative to this package source/dist)
 * 3. Ancestor directories walking up from this file (monorepo / hoisted dependencies)
 * 4. Current working directory node_modules/.bin (process.cwd())
 * 5. Fallback to system PATH
 */
export function resolveAstGrepBinary(): string {
  if (process.env.AST_GREP_BIN && process.env.AST_GREP_BIN.trim()) {
    return process.env.AST_GREP_BIN;
  }

  const isWin = process.platform === 'win32';
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

  // 1. Search walking up from current module file location
  const moduleMatch = searchDirectory(getModuleDir());
  if (moduleMatch) return moduleMatch;

  // 2. Search walking up from current working directory
  const cwdMatch = searchDirectory(process.cwd());
  if (cwdMatch) return cwdMatch;

  // Fallback to system PATH
  return isWin ? 'ast-grep.exe' : 'ast-grep';
}

/**
 * Checks if the ast-grep binary can be executed.
 */
export async function verifyAstGrepBinary(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');

  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isCmd,
    });

    proc.on('error', (err) => {
      resolve({
        ok: false,
        error: `ast-grep binary was not found or failed to start: ${err.message}. Please run 'bun install' or install '@ast-grep/cli'.`,
      });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, path: bin });
      } else {
        resolve({
          ok: false,
          error: `ast-grep exited with code ${code}. Please verify your '@ast-grep/cli' installation.`,
        });
      }
    });
  });
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
    msg.includes('Make sure @ast-grep/cli is installed')
  );
}

/**
 * Executes an ast-grep query either on an in-memory string (via stdin) or against file paths on disk.
 */
export async function executeAstGrep(options: AstGrepQueryOptions): Promise<RawMatch[]> {
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');
  const lang = options.language || 'ts';
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

      const proc = spawn(bin, args, {
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: isCmd,
      });

      if (useStdin && proc.stdin) {
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
            `Failed to execute ast-grep at "${bin}": ${err.message}. Make sure @ast-grep/cli is installed.`
          )
        );
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim() || `process exited with code ${code}`;
          let errorMsg = `ast-grep error (exit code ${code}): ${detail}`;
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
  const bin = resolveAstGrepBinary();
  const isCmd = bin.endsWith('.cmd') || bin.endsWith('.bat');
  const args = ['run', '--pattern', code, '--lang', language, '--debug-query=cst', '--stdin'];

  return new Promise((resolve, reject) => {
    let stderr = '';

    const proc = spawn(bin, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: isCmd,
    });

    // Immediately close stdin to prevent ast-grep from scanning the working directory
    proc.stdin?.end();

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to dump syntax tree: ${err.message}`));
    });

    proc.on('close', (code) => {
      const output = stderr.trim();
      if (code !== 0) {
        reject(new Error(`ast-grep dump failed (exit ${code}): ${output || 'unknown error'}`));
        return;
      }
      resolve(output);
    });
  });
}
