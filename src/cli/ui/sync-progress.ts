import type { SyncProgressEvent } from '../../engine/v2';

export const CLI_ANSI = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  redBold: '\x1b[1;31m',
  yellowBold: '\x1b[1;33m',
  reset: '\x1b[0m',
} as const;

const STAGE_LABELS: Record<SyncProgressEvent['stage'], string> = {
  scan: 'Scanning files',
  parse: 'Parsing AST & symbols',
  resolve: 'Resolving refs & routes',
  commit: 'Writing SQLite graph & FTS',
};

export function formatSyncDuration(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`;
}

export interface SyncProgressReporter {
  onProgress: (ev: SyncProgressEvent) => void;
  stageDurationsMs: Record<string, number>;
}

/**
 * Shared TTY/CI-aware progress reporter for `strata init` and `strata sync`.
 */
export function createSyncProgressReporter(interactive?: boolean): SyncProgressReporter {
  const isTest = process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';
  const isCI = Boolean(process.env.CI);
  const isInteractiveOut = interactive ?? (Boolean(process.stdout.isTTY) && !isTest && !isCI);
  const stageDurationsMs: Record<string, number> = {};
  let lastRenderAt = 0;

  const onProgress = (ev: SyncProgressEvent) => {
    const label = STAGE_LABELS[ev.stage];
    if (ev.status === 'done') {
      if (ev.durationMs !== undefined) {
        stageDurationsMs[ev.stage] = ev.durationMs;
      }
      const suffix = ev.detail ?? 'done';
      const line = `${CLI_ANSI.cyan}│${CLI_ANSI.reset}  ${CLI_ANSI.green}◆${CLI_ANSI.reset} ${label} — ${suffix}`;
      if (isInteractiveOut) {
        process.stdout.write(`\r\x1b[K${line}\n`);
      } else {
        console.log(line);
      }
      lastRenderAt = 0;
      return;
    }

    if (!isInteractiveOut) return;
    const now = performance.now();
    if (ev.status === 'progress' && now - lastRenderAt < 80) return;
    lastRenderAt = now;

    const progressText =
      ev.total !== undefined && ev.total > 0 && ev.completed !== undefined
        ? `${ev.completed.toLocaleString()}/${ev.total.toLocaleString()}`
        : '...';
    process.stdout.write(
      `\r\x1b[K${CLI_ANSI.cyan}│${CLI_ANSI.reset}  ${CLI_ANSI.cyan}◆${CLI_ANSI.reset} ${label} — ${CLI_ANSI.dim}${progressText}${CLI_ANSI.reset}`
    );
  };

  return { onProgress, stageDurationsMs };
}

export interface ClassifiedSyncError {
  failurePhase: string;
  recoveryInstruction: string;
  rawMessage: string;
}

export function classifySyncError(err: unknown): ClassifiedSyncError {
  const rawMessage = err instanceof Error ? err.message : String(err);
  let failurePhase = 'AST Component Indexing';
  let recoveryInstruction =
    "Inspect error trace, verify component syntax, then run 'strata sync --force' to rebuild graph cache.";

  if (rawMessage.startsWith('INDEX_SCHEMA_TOO_NEW:')) {
    failurePhase = 'Index Compatibility';
    recoveryInstruction = 'Use a Strata build that supports the existing SQLite index schema.';
  } else if (
    rawMessage.includes('database') ||
    rawMessage.includes('SQLite') ||
    rawMessage.includes('locked') ||
    rawMessage.includes('busy')
  ) {
    failurePhase = 'Database Access';
    recoveryInstruction = "Ensure no other process is locking '.strata/graph.db', then run 'strata sync'.";
  } else if (rawMessage.includes('parse') || rawMessage.includes('SyntaxError')) {
    failurePhase = 'Component Parser';
    recoveryInstruction = "Check invalid syntax in frontend templates, then run 'strata sync'.";
  } else if (rawMessage.includes('EACCES') || rawMessage.includes('permission')) {
    failurePhase = 'Filesystem Permissions';
    recoveryInstruction = "Check read/write permissions for '.strata/' and project root, then re-run.";
  }

  return { failurePhase, recoveryInstruction, rawMessage };
}
