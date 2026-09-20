#!/usr/bin/env bun
import { existsSync, promises as fs } from 'node:fs';
import { findCode, findCodeByRule, findComponentUsage, formatMatchesAsText } from './engine/search';
import { extractComponentContract, formatContractAsText } from './engine/contract';
import { getComponentTree, formatTreeAsText } from './engine/tree';
import { findUnusedComponents, formatUnusedAsText } from './engine/audit';
import { scanRoutes, formatRoutesAsText } from './engine/routes';
import { generatePatchPlan } from './engine/patch-plan';
import { extractWorkspaceApiContracts, formatApiContractsAsText } from './engine/api-contract';
import {
  formatStateImpactAsText,
  formatUnusedStateAsText,
  findUnusedState,
  queryStateImpact,
  syncWorkspace,
  closeAllDatabases,
} from './engine/database';
import { handleStrataInit } from './cli/commands/init';
import { STRATA_VERSION } from './version';
import type { PatchRefactorType, RouteFramework } from './types';

function printHelp() {
  console.log(`
strata — Multi-Framework Frontend Structural Code Search & Intelligence CLI

Usage:
  strata <command> [options]

Commands:
  serve                                   Start MCP stdio daemon server
  init [target-dir]                       Initialize strata configuration and agent rules
  search, find <pattern>                  AST structural code search across codebase
  find-component-usage, usage <component> Find all usages and callers of a component
  contract, extract-contract <file>       Extract public component contract (props, emits, slots)
  tree, component-tree [entry-file]       Inspect component dependency hierarchy
  patch-plan, patch <file>                Generate precision refactoring patch plan
  apis, api-contracts [target-dir]        Extract backend/frontend API integration contracts
  routes, scan-routes [target-dir]        Scan and resolve file-based routing paths
  impact, state-impact <state-id>         Trace blast radius and state consumers
  unused-state, dead-state [target-dir]   Audit unused stores, composables, or state variables
  sync [target-dir]                       Synchronize project cache and index database
  unused, audit [target-dir]              Audit dead or unreferenced components
  rule <rule-file-or-yaml>                Execute custom ast-grep lint and audit rules

Global Options:
  -p, --path <dir|file>                   Target directory or file (default: .)
  -v, --version                           Show version number
  --json                                  Output raw JSON instead of formatted text
  -h, --help                              Show this help message

Command-specific Options:
  init:
    --force                               Overwrite existing config files and instructions

  patch-plan:
    --refactor <type>                     Refactor operation: rename_prop | remove_prop | rename_event (default: rename_prop)
    --old <name>                          Current/old identifier or property name
    --new <name>                          New identifier or property name

  tree:
    --route <route-path>                  URL route path to resolve (e.g. "/catalog")
    --depth <number>                      Max hierarchy tree depth (default: 3)
    --direction <dir>                     Traversal direction: downward | upward (default: downward)
    --alias <prefix=path>                 Path alias mapping, comma-separated (e.g. "@/=resources/js/")
    --scope-filter <scope>                Domain or package filter (e.g. "apps/web")

  routes:
    --prefix <prefix>                     Filter routes by URL prefix (e.g. "/api", "/auth")
    --view <mode>                         View layout: summary | full | tree (default: auto)
    --framework <hint>                    Framework hint (next-app, nuxt, astro, inertia)

  unused:
    --ignore <pattern>                    Glob pattern to ignore (comma-separated)
    --include-pages                       Include file-based page views in audit

  search:
    --lang <lang>                         Target language hint (default: ts)

  find-component-usage:
    --scope <scope>                       Component scope: template | script | both (default: both)
`);
}

function toCamelCase(str: string): string {
  return str.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const camelKey = toCamelCase(key);
      const next = args[i + 1];
      let val: string | boolean = true;
      if (next && !next.startsWith('-')) {
        val = next;
        i++;
      }
      flags[key] = val;
      if (camelKey !== key) {
        flags[camelKey] = val;
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

  if (flags.version) {
    console.log(`strata v${STRATA_VERSION}`);
    return;
  }

  if (flags.help || !command) {
    printHelp();
    return;
  }

  const targetPath = (flags.path as string) || '.';
  const isJson = Boolean(flags.json);

  try {
    if (command === 'serve') {
      const { runServer } = await import('./mcp');
      await runServer();
      return;
    }

    if (command === 'init') {
      const initPath = positional[1] || targetPath;
      await handleStrataInit({ cwd: initPath, force: Boolean(flags.force) });
      return;
    }

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

    if (command === 'patch-plan' || command === 'patch') {
      const componentPath = positional[1];
      if (!componentPath) {
        console.error('Error: Component file path is required for patch-plan (e.g. strata patch-plan src/Button.vue --refactor rename_prop --old type --new variant).');
        process.exit(1);
      }

      const refactorType = (flags.refactor ?? flags['refactor-type'] ?? 'rename_prop') as PatchRefactorType;
      const oldName = String(flags.old ?? flags['old-name'] ?? '');
      const newName = flags.new ? String(flags.new) : (flags['new-name'] ? String(flags['new-name']) : undefined);

      if (!oldName) {
        console.error('Error: --old <name> is required.');
        process.exit(1);
      }

      const result = await generatePatchPlan({
        componentPath,
        refactorType,
        oldName,
        newName,
        targetPath,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nPrescriptive Patch Plan: ${refactorType.toUpperCase()} on "${componentPath}"`);
        console.log(`Audited ${result.totalConsumersAudited} consumers, found ${result.totalPatches} patches:\n`);
        for (const patch of result.patches) {
          console.log(`- ${patch.file}:${patch.line}:${patch.column} (<${patch.targetTag}>)`);
          console.log(`  Current:  ${patch.oldSnippet}`);
          console.log(`  Replace:  ${patch.newSnippet || '(remove)'}\n`);
        }
      }
      return;
    }

    if (command === 'apis' || command === 'api-contracts') {
      const scanPath = positional[1] || targetPath;
      const result = await extractWorkspaceApiContracts({ targetPath: scanPath });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatApiContractsAsText(result));
      }
      return;
    }

    console.error(`Unknown command: "${command}". Run "strata --help" for available commands.`);
    process.exit(1);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    closeAllDatabases();
  }
}

// Only auto-run when executed as the CLI entry (cli.js/cli.ts).
// When bundled into mcp.js (single-binary mode, mcp.ts imports main from here),
// this guard prevents double execution that would corrupt MCP stdio JSON-RPC.
const cliEntry = process.argv[1] ?? '';
if (import.meta.main && (cliEntry.endsWith('cli.js') || cliEntry.endsWith('cli.ts'))) {
  main();
}
