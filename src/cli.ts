#!/usr/bin/env bun
import { resolve } from 'node:path';
import {
  defaultSemanticPool,
  defaultWarmDbPool,
  syncWorkspaceV3,
} from './engine/v2';
import {
  inspectFileTool,
  mapWorkspaceTool,
  queryGraphTool,
  readSliceTool,
  searchCodeTool,
} from './tools';
import { handleStrataInit } from './cli/commands/init';
import { parseSafePositiveInt, parseStringList } from './engine/path-resolver';
import { STRATA_VERSION } from './version';
import { StrataTelemetry, formatSummaryAsText } from './engine/telemetry';
import { printRootHelp, printCommandHelp } from './cli/help';
import { parseStringFlag, parseArgs } from './cli/arguments';

export { printRootHelp } from './cli/help';
export { printCommandHelp } from './cli/help';
export { BOOLEAN_FLAGS } from './cli/arguments';
export { parseStringFlag } from './cli/arguments';

function printToolResponse(res: { isError?: boolean; content: Array<{ text?: string }> }): void {
  const text = res.content.map((c) => c.text ?? '').join('\n');
  if (res.isError) {
    console.error(text);
    process.exit(1);
  }
  console.log(text);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.version || flags.v) {
    console.log(STRATA_VERSION);
    return;
  }

  const command = positional[0];
  const isJson = Boolean(flags.json);

  if (!command || command === 'help' || (command && (flags.help || flags.h))) {
    if (command && command !== 'help') {
      printCommandHelp(command);
    } else {
      printRootHelp();
    }
    return;
  }

  if (command === 'serve') {
    const { startMcpServer } = await import('./mcp');
    await startMcpServer();
    return;
  }

  try {
    switch (command) {
      case 'init': {
        const targetDir = parseStringFlag(flags.path ?? flags.p) ?? positional[1] ?? process.cwd();
        await handleStrataInit({
          cwd: resolve(targetDir),
          force: Boolean(flags.force || flags.f),
          harness: parseStringFlag(flags.harness ?? flags.agent),
          yes: Boolean(flags.yes || flags.y),
        });
        break;
      }

      case 'sync': {
        const targetDir = resolve(parseStringFlag(flags.path ?? flags.p) ?? positional[1] ?? process.cwd());
        const stats = await syncWorkspaceV3(targetDir, {
          packageKey: parseStringFlag(flags.package),
          force: Boolean(flags.force || flags.f),
        });
        if (isJson) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log(
            `Synced ${stats.packagesSynced} package(s) [${stats.mode}] in ${stats.durationMs}ms — added=${stats.added}, modified=${stats.modified}, unchanged=${stats.unchanged}, deleted=${stats.deleted}, symbols=${stats.symbolsIndexed}, edges=${stats.edgesIndexed}`
          );
        }
        break;
      }

      case 'map': {
        const root = resolve(parseStringFlag(flags.path ?? flags.p) ?? positional[1] ?? process.cwd());
        const res = await mapWorkspaceTool.handler({
          root,
          view: parseStringFlag(flags.view) ?? 'overview',
          package: parseStringFlag(flags.package),
          path_prefix: parseStringFlag(flags.prefix),
          limit: parseSafePositiveInt(flags.limit),
          cursor: parseStringFlag(flags.cursor),
          format: isJson ? 'json' : 'text',
        });
        printToolResponse(res);
        break;
      }

      case 'inspect': {
        const filePath = positional[1];
        if (!filePath) {
          console.error('Error: Please provide a target file path. Example: strata inspect src/Button.vue');
          process.exit(1);
        }
        const root = resolve(parseStringFlag(flags.path ?? flags.p) ?? process.cwd());
        const sections = parseStringList(flags.sections);
        const res = await inspectFileTool.handler({
          root,
          path: filePath,
          ...(sections?.length ? { sections } : {}),
          resolve_types: !flags['no-types'],
          format: isJson ? 'json' : 'text',
        });
        printToolResponse(res);
        break;
      }

      case 'graph': {
        const query = positional[1];
        if (!query) {
          console.error(
            'Error: Provide a graph query (definition | references | call_hierarchy | component_tree | state_flow | impact).'
          );
          process.exit(1);
        }
        const root = resolve(parseStringFlag(flags.path ?? flags.p) ?? process.cwd());
        const file = parseStringFlag(flags.file) ?? positional[2];
        const packages = parseStringList(flags.package);
        const maxDepth = parseSafePositiveInt(flags.depth ?? flags['max-depth']);
        const res = await queryGraphTool.handler({
          root,
          query,
          target: {
            ...(file ? { file } : {}),
            ...(parseStringFlag(flags.symbol) ? { symbol: parseStringFlag(flags.symbol) } : {}),
            ...(parseStringFlag(flags['symbol-id']) ? { symbol_id: parseStringFlag(flags['symbol-id']) } : {}),
            ...(parseStringFlag(flags.member) ? { member: parseStringFlag(flags.member) } : {}),
          },
          direction: parseStringFlag(flags.direction),
          ...(packages?.length || maxDepth
            ? {
                scope: {
                  ...(packages?.length ? { packages } : {}),
                  ...(maxDepth ? { max_depth: maxDepth } : {}),
                },
              }
            : {}),
          limit: parseSafePositiveInt(flags.limit),
          cursor: parseStringFlag(flags.cursor),
          format: isJson ? 'json' : 'text',
        });
        printToolResponse(res);
        break;
      }

      case 'read': {
        const root = resolve(parseStringFlag(flags.path ?? flags.p) ?? process.cwd());
        const linesRaw = parseStringFlag(flags.lines);
        let lines: [number, number] | undefined;
        if (linesRaw) {
          const parts = linesRaw.split(/[:-]/).map((n) => Number.parseInt(n.trim(), 10));
          if (parts.length === 2 && Number.isInteger(parts[0]) && Number.isInteger(parts[1])) {
            lines = [parts[0], parts[1]];
          }
        }
        const res = await readSliceTool.handler({
          root,
          source_ref: parseStringFlag(flags.ref ?? flags['source-ref']),
          symbol_id: parseStringFlag(flags['symbol-id']),
          path: positional[1],
          symbol: parseStringFlag(flags.symbol),
          block: parseStringFlag(flags.block),
          ...(lines ? { lines } : {}),
          max_lines: parseSafePositiveInt(flags['max-lines']),
        });
        printToolResponse(res);
        break;
      }

      case 'search': {
        const query = positional[1];
        if (!query) {
          console.error('Error: Please provide a search query. Example: strata search formatOrderTotal');
          process.exit(1);
        }
        const root = resolve(parseStringFlag(flags.path ?? flags.p) ?? process.cwd());
        const res = await searchCodeTool.handler({
          root,
          query,
          kind: parseStringFlag(flags.kind) ?? 'symbol',
          package: parseStringFlag(flags.package),
          path_prefix: parseStringFlag(flags.prefix),
          limit: parseSafePositiveInt(flags.limit),
          cursor: parseStringFlag(flags.cursor),
          format: isJson ? 'json' : 'text',
        });
        printToolResponse(res);
        break;
      }

      case 'stats':
      case 'telemetry': {
        const targetDir = resolve(parseStringFlag(flags.path ?? flags.p) ?? positional[1] ?? process.cwd());
        const days = parseSafePositiveInt(flags.days) ?? 7;
        const summary = StrataTelemetry.getSummary(targetDir, days);
        if (isJson) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(formatSummaryAsText(summary));
        }
        break;
      }

      default:
        console.error(`Unknown command: "${command}". Run "strata --help" for usage.`);
        process.exit(1);
    }
  } finally {
    defaultSemanticPool.disposeAll();
    defaultWarmDbPool.closeAll();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
