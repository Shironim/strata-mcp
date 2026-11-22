import { resolve } from 'node:path';
import { StrataTelemetry } from '../../engine/telemetry';
import { defaultWarmDbPool, syncWorkspaceV3 } from '../../engine/v2';
import { STRATA_VERSION } from '../../version';
import {
  classifySyncError,
  CLI_ANSI,
  createSyncProgressReporter,
  formatSyncDuration,
} from '../ui/sync-progress';

export interface StrataSyncOptions {
  cwd?: string;
  packageKey?: string;
  force?: boolean;
  json?: boolean;
}

export async function handleStrataSync(options: StrataSyncOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { cyan, green, dim, bold, redBold, yellowBold, reset } = CLI_ANSI;

  if (options.json) {
    try {
      const stats = await syncWorkspaceV3(cwd, {
        packageKey: options.packageKey,
        force: options.force,
      });
      const totalFiles = stats.added + stats.modified + stats.unchanged;
      StrataTelemetry.recordSync(cwd, {
        source: 'strata_sync',
        mode: stats.mode,
        files: totalFiles,
        symbols: stats.symbolsIndexed,
        edges: stats.edgesIndexed,
        packages: stats.packagesSynced,
        durationMs: stats.durationMs,
        workersUsed: stats.workersUsed,
      });
      console.log(JSON.stringify(stats, null, 2));
    } finally {
      defaultWarmDbPool.close(cwd);
    }
    return;
  }

  console.log(`\n${cyan}◆${reset}  ${bold}strata sync v${STRATA_VERSION}${reset}`);
  console.log(`${cyan}│${reset}  ${dim}Workspace: ${cwd}${reset}`);
  console.log(`${cyan}│${reset}`);

  const scopeLabel = options.packageKey
    ? `Syncing package '${options.packageKey}'`
    : options.force
      ? 'Force rebuilding workspace index'
      : 'Syncing workspace index';
  console.log(`${cyan}◇${reset}  ${scopeLabel}:`);

  const { onProgress, stageDurationsMs } = createSyncProgressReporter();

  try {
    const stats = await syncWorkspaceV3(cwd, {
      packageKey: options.packageKey,
      force: options.force,
      onProgress,
    });

    const totalFiles = stats.added + stats.modified + stats.unchanged;
    StrataTelemetry.recordSync(cwd, {
      source: 'strata_sync',
      mode: stats.mode,
      files: totalFiles,
      symbols: stats.symbolsIndexed,
      edges: stats.edgesIndexed,
      packages: stats.packagesSynced,
      durationMs: stats.durationMs,
      workersUsed: stats.workersUsed,
      stages: stageDurationsMs,
    });

    const durationLabel = formatSyncDuration(stats.durationMs);
    console.log(`${cyan}│${reset}`);
    if (stats.mode === 'git-fast-path') {
      console.log(
        `${cyan}│${reset}  ${green}✔${reset} Clean Git HEAD fast-path — index already up to date (${totalFiles.toLocaleString()} files, ${stats.symbolsIndexed.toLocaleString()} symbols, ${stats.edgesIndexed.toLocaleString()} edges, ${stats.packagesSynced} package(s)) in ${durationLabel}`
      );
    } else if (options.packageKey && stats.packagesSynced === 0) {
      console.log(
        `${cyan}│${reset}  ${yellowBold}!${reset} Package '${options.packageKey}' did not match any discovered workspace package (${durationLabel}).`
      );
    } else {
      console.log(
        `${cyan}│${reset}  ${green}✔${reset} Synced ${stats.packagesSynced} package(s) [${stats.mode}] in ${durationLabel} — added=${stats.added}, modified=${stats.modified}, unchanged=${stats.unchanged}, deleted=${stats.deleted}, symbols=${stats.symbolsIndexed.toLocaleString()}, edges=${stats.edgesIndexed.toLocaleString()}`
      );
    }
    console.log(`${cyan}│${reset}`);
    console.log(`${cyan}└${reset}  ${bold}${green}Sync complete.${reset}\n`);
  } catch (err: unknown) {
    const { failurePhase, recoveryInstruction, rawMessage } = classifySyncError(err);
    console.error(`${cyan}│${reset}`);
    console.error(`${cyan}│${reset}  ${redBold}✕ Workspace sync failed (${failurePhase})${reset}`);
    console.error(`${cyan}│${reset}  ${redBold}Error Details:${reset} ${rawMessage}`);
    console.error(`${cyan}│${reset}  ${yellowBold}Recovery Instruction:${reset} ${recoveryInstruction}`);
    console.error(`${cyan}│${reset}`);
    throw new Error(`Workspace sync failed (${failurePhase}): ${rawMessage}. ${recoveryInstruction}`);
  } finally {
    defaultWarmDbPool.close(cwd);
  }
}
