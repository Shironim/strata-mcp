#!/usr/bin/env bun
import { existsSync, promises as fs } from 'node:fs';
import { findCode, findCodeByRule, findComponentUsage, formatMatchesAsText } from './engine/search';
import { dumpSyntaxTree } from './engine/astgrep';
import { extractComponentContract, formatContractAsText } from './engine/contract';
import { getComponentTree, formatTreeAsText } from './engine/tree';
import { findUnusedComponents, formatUnusedAsText } from './engine/audit';
import { scanRoutes, formatRoutesAsText } from './engine/routes';
import {
  formatStateImpactAsText,
  formatUnusedStateAsText,
  findUnusedState,
  queryStateImpact,
  syncWorkspace,
} from './engine/database';
import type { RouteFramework } from './types';

function printHelp() {
  console.log(`
strata — Multi-Framework Frontend Structural Code Search & Intelligence CLI

Usage:
  strata search <pattern> [options]
  strata find-component-usage <component-name> [options]
  strata contract <component-file> [options]
  strata tree [entry-file] [--route <path>] [options]
  strata routes [target-dir] [options]
  strata impact <state-identifier> [options]
  strata unused-state [target-dir] [options]
  strata sync [target-dir]
  strata unused [target-dir] [options]
  strata rule <rule-file-or-yaml> [options]
  strata dump <code> [options]

Options:
  --path <dir|file>       Target directory or file (default: .)
  --route <route-path>    URL route path to resolve for tree command (e.g. "/catalog")
  --prefix <prefix>       Filter routes by URL prefix (e.g. "/services", "/auth")
  --view <mode>           Route view mode: summary | full | tree (default: auto)
  --depth <number>        Max tree depth for tree command (default: 3)
  --direction <dir>       Tree traversal direction: downward | upward (default: downward)
  --framework <hint>      Framework hint for routes command (next-app, nuxt, astro, inertia)
  --alias <prefix=path>   Alias map for tree command, comma-separated (e.g. "@/=resources/js/")
  --scope-filter <scope>  Domain or package filter for tree command (e.g. "apps/web")
  --ignore <pattern>      Glob pattern to ignore (can repeat or comma-separated)
  --include-pages         Include file-based page views in unused component audit
  --lang <lang>           Language hint (default: ts)
  --scope <scope>         Component scope: template | script | both (default: both)
  --json                  Output raw JSON instead of text
  --help, -h              Show this help message
`);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === '-p') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags.path = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Parses a comma-separated `--alias prefix=path` value into an alias map.
 * Example: `@/=resources/js/,@components/=src/components/`.
 */
function parseAliasMap(raw: string | boolean | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'string') return undefined;

  const aliasMap: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex <= 0) continue;

    const alias = part.slice(0, equalsIndex).trim();
    const target = part.slice(equalsIndex + 1).trim();
    if (alias && target) aliasMap[alias] = target;
  }

  return Object.keys(aliasMap).length > 0 ? aliasMap : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];

  if (flags.help || !command) {
    printHelp();
    return;
  }

  const targetPath = (flags.path as string) || '.';
  const isJson = Boolean(flags.json);

  try {
    if (command === 'search' || command === 'find') {
      const pattern = positional[1];
      if (!pattern) {
        console.error('Error: Pattern is required for search command.');
        process.exit(1);
      }

      const matches = await findCode({
        pattern,
        targetPath,
        language: (flags.lang as string) || 'ts',
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'find-component-usage' || command === 'usage') {
      const componentName = positional[1];
      if (!componentName) {
        console.error('Error: Component name is required.');
        process.exit(1);
      }

      const scope =
        flags.scope === 'template' || flags.scope === 'script' || flags.scope === 'both'
          ? flags.scope
          : 'both';

      const matches = await findComponentUsage({
        componentName,
        targetPath,
        scope,
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'rule') {
      const ruleInput = positional[1];
      if (!ruleInput) {
        console.error('Error: Rule file or inline YAML is required.');
        process.exit(1);
      }

      let ruleYaml = ruleInput;
      if (existsSync(ruleInput)) {
        ruleYaml = await fs.readFile(ruleInput, 'utf8');
      }

      const matches = await findCodeByRule({
        rule: ruleYaml,
        targetPath,
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'contract' || command === 'extract-contract') {
      const filePath = positional[1];
      if (!filePath) {
        console.error('Error: Component file path is required.');
        process.exit(1);
      }

      const contract = await extractComponentContract(filePath);
      if (isJson) {
        console.log(JSON.stringify(contract, null, 2));
      } else {
        console.log(formatContractAsText(contract));
      }
      return;
    }

    if (command === 'tree' || command === 'component-tree') {
      const entryFile = positional[1];
      const routePath = flags.route ? String(flags.route) : undefined;

      if (!entryFile && !routePath) {
        console.error('Error: Either an entry file path or --route <path> is required.');
        process.exit(1);
      }

      const maxDepth = flags.depth ? Number(flags.depth) : 3;
      const direction = flags.direction === 'upward' ? 'upward' : 'downward';
      const aliasMap = parseAliasMap(flags.alias);
      const scopeFilter = (flags['scope-filter'] || flags.scopeFilter) as string | undefined;
      const result = await getComponentTree({
        entryPath: entryFile,
        routePath,
        targetPath,
        scopeFilter,
        maxDepth,
        direction,
        aliasMap,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatTreeAsText(result));
      }
      return;
    }

    if (command === 'routes' || command === 'scan-routes') {
      const scanPath = positional[1] || targetPath;
      const result = await scanRoutes({
        targetPath: scanPath,
        frameworkHint: flags.framework as RouteFramework | undefined,
        prefix: (flags.prefix as string) || undefined,
        view: (flags.view as 'summary' | 'full' | 'tree') || undefined,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatRoutesAsText(result));
      }
      return;
    }

    if (command === 'unused' || command === 'find-unused' || command === 'audit') {
      const auditPath = positional[1] || targetPath;
      const ignoreArg = flags.ignore ? String(flags.ignore).split(',') : undefined;
      const excludePages = flags['include-pages'] ? false : true;

      const result = await findUnusedComponents({
        targetPath: auditPath,
        ignorePatterns: ignoreArg,
        excludePages,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatUnusedAsText(result));
      }
      return;
    }

    if (command === 'unused-state' || command === 'find-unused-state' || command === 'dead-state') {
      const auditPath = positional[1] || targetPath;
      const result = await findUnusedState(auditPath);

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatUnusedStateAsText(result));
      }
      return;
    }

    if (command === 'impact' || command === 'state-impact') {
      const identifier = positional[1];
      if (!identifier) {
        console.error('Error: State identifier (store, context, composable) is required.');
        process.exit(1);
      }

      const result = await queryStateImpact(targetPath, identifier);
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatStateImpactAsText(result));
      }
      return;
    }

    if (command === 'sync') {
      const syncPath = positional[1] || targetPath;
      const stats = await syncWorkspace(syncPath);
      if (isJson) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(
          `Synced workspace: ${stats.total} total files (${stats.added} added, ${stats.modified} modified, ${stats.deleted} deleted, ${stats.unchanged} unchanged) in ${stats.durationMs}ms.`
        );
      }
      return;
    }

    if (command === 'dump') {
      const code = positional[1];
      if (!code) {
        console.error('Error: Code snippet is required.');
        process.exit(1);
      }

      const dump = await dumpSyntaxTree(code, (flags.lang as string) || 'ts');
      console.log(dump);
      return;
    }

    console.error(`Unknown command: "${command}". Run "strata --help" for available commands.`);
    process.exit(1);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
