#!/usr/bin/env bun
import { readSourceFile } from './engine/source-file';
import { existsSync, promises as fs } from 'node:fs';
import { findCode, findCodeByRule, findComponentUsage, formatMatchesAsText } from './engine/search';
import { extractComponentContract, formatContractAsText } from './engine/contract';
import { sliceSymbol, formatSymbolSliceAsText } from './engine/slicer';
import { auditEventHandlers, formatEventHandlerAuditAsText } from './engine/reactivity';
import { getComponentTree, formatTreeAsText } from './engine/tree';
import { findUnusedComponents, formatUnusedAsText } from './engine/audit';
import { scanRoutes, formatRoutesAsText } from './engine/routes';
import { generatePatchPlan } from './engine/patch-plan';
import { extractWorkspaceApiContracts, formatApiContractsAsText } from './engine/api-contract';
import { auditPageArchetypeDrift, formatArchetypeAuditAsText } from './engine/archetype';
import { findSimilarTemplates, formatSimilarTemplatesAsText } from './engine/template-similarity';
import { auditDesignTokens, formatDesignAuditAsText } from './engine/style-audit';
import { auditBundleHealth, formatBundleAuditAsText } from './engine/bundle-audit';
import {
  formatStateImpactAsText,
  formatUnusedStateAsText,
  findUnusedState,
  queryStateImpact,
  syncWorkspace,
  closeAllDatabases,
  traceStateChain,
  formatStateChainAsText,
} from './engine/database';
import { handleStrataInit } from './cli/commands/init';
import {
  normalizeAuditTarget,
  parseAliasMapInput,
  parseSafeFloat,
  parseSafePositiveInt,
  parseStringList,
  resolveProjectRoot,
  VALID_AUDIT_TARGETS,
} from './engine/path-resolver';
import { STRATA_VERSION } from './version';
import { StrataTelemetry, formatSummaryAsText } from './engine/telemetry';
import type { PatchRefactorType, RouteFramework } from './types';

export function printRootHelp() {
  console.log(`
strata — Frontend Structural Code Search & Intelligence CLI

Usage:
  strata <command> [options]
  strata <command> --help        Show options for a specific command

Operational Commands:
  serve                          Start MCP stdio daemon server
  init [dir]                     Initialize strata index, configs, and agent rules
  sync [dir]                     Synchronize project cache and index database

Core Analytical Commands (Aligned with 6 MCP Tools):
  find, search <pattern>         AST code search (--component, --rule, --lang)
  inspect, contract <file>       Inspect component contract (--symbol, --audit-events)
  tree, component-tree [entry]   Inspect component hierarchy tree (--route, --direction)
  trace, impact <state-id>       Trace state blast radius and consumers (--depth, --role)
  audit [dir]                    Audit frontend architecture (--target, --threshold)
  patch, patch-plan <file>       Generate prescriptive refactoring patch plan
  stats, telemetry [dir]         Show tool latency, error rates, and telemetry stats

Direct Shortcuts:
  routes, apis, dead-state, archetype, usage, rule

Global Options:
  -p, --path <dir|file>          Target directory or file (default: .)
  -v, --version                  Show version number
  --json                         Output raw JSON instead of formatted text
  -h, --help                     Show help message
`);
}

export function printCommandHelp(command: string) {
  switch (command) {
    case 'init':
      console.log(`
Usage: strata init [target-dir] [options]

Initialize strata index, local MCP configs, and agent rules.

Options:
  --harness, --agent <name>  Target harness (gemini | claude | cursor | codex | opencode | all)
  -f, --force                Overwrite existing agent rules and configurations
  -y, --yes                  Skip interactive prompts, auto-accept defaults
  -p, --path <dir>           Target directory (default: .)
`);
      break;

    case 'find':
    case 'search':
    case 'usage':
    case 'rule':
      console.log(`
Usage: strata find <pattern> [options]

AST code search across components and scripts.

Options:
  --component <name>         Search all usages of a component (alias for "usage")
  --rule <rule-yaml>         Execute custom ast-grep YAML rule (alias for "rule")
  --lang <lang>              Target language hint (default: ts)
  --scope <scope>            Scope: template | script | both (default: both)
  -p, --path <path>          Target directory or file (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'inspect':
    case 'contract':
      console.log(`
Usage: strata inspect <component-file> [options]

Inspect component contract (props, emits, slots, state, dependencies).

Options:
  --symbol <name>            Extract specific symbol or function with line numbers
  --audit-events             Audit template-to-script event handler integrity
  --json                     Output raw JSON
`);
      break;

    case 'tree':
    case 'component-tree':
      console.log(`
Usage: strata tree [entry-file] [options]

Inspect component hierarchy and import dependency trees.

Options:
  --route <route-path>       Resolve tree starting from URL route (e.g. "/catalog")
  --depth, --max-depth <n>   Max tree depth (default: 3)
  --direction <dir>          Traversal: downward | upward (default: downward)
  --alias <prefix=path>      Path alias mapping (e.g. "@/=resources/js/")
  --scope-filter <scope>     Domain or package filter (e.g. "apps/web")
  -p, --path <dir>           Target directory (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'trace':
    case 'impact':
      console.log(`
Usage: strata trace <state-id> [options]

Trace reactive state blast radius and consumers.

Options:
  --depth <n>                Traversal depth (default: 1, >1 for multi-hop)
  --direction <dir>          Direction: consumers | dependencies | both (default: both)
  --role <role>              Role filter: all | mutators | readers (default: all)
  -p, --path <dir>           Target directory (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'audit':
    case 'routes':
    case 'apis':
    case 'dead-state':
    case 'unused-state':
    case 'archetype':
      console.log(`
Usage: strata audit [target-dir] [options]

Audit frontend architecture for dead code, drift, and contract violations.

Targets (--target <target>):
  dead-components (default)  Find unreferenced components
  dead-state                 Detect unused reactive state / stores
  routes                     Extract client-side route manifest
  similar-templates          Detect copy-pasted UI template structures
  design-tokens              Detect raw CSS color/spacing escapes
  bundle-health              Scan for heavy dependencies and barrel file leaks
  api-contracts              Extract and validate API endpoint calls
  archetype-drift            Detect structural drift from page archetype
  all                        Run all architectural audit targets

Options:
  --threshold <n>            Similarity threshold for templates (default: 0.8)
  --exemplar <file>          Reference page for archetype-drift comparison
  --ignore <patterns>        Comma-separated glob patterns to ignore
  --include-pages            Include file-based page views in dead-code audit
  --scope-path <dir>         Sub-directory or package scope filter
  --exclude-dirs <dirs>      Comma-separated directory names to exclude
  -p, --path <dir>           Target directory (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'patch':
    case 'patch-plan':
      console.log(`
Usage: strata patch <component-file> [options]

Generate prescriptive refactoring patch plans across callers and contracts.

Options:
  --refactor <type>          Operation: rename_prop | remove_prop | rename_event |
                             rename_model | rename_slot (default: rename_prop)
  --old <name>               Current/old identifier or property name
  --new <name>               New identifier or property name (required for rename_*)
  -p, --path <dir>           Workspace root path (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'sync':
      console.log(`
Usage: strata sync [target-dir] [options]

Synchronize project cache and AST index database.

Options:
  -p, --path <dir>           Target directory (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'stats':
    case 'telemetry':
      console.log(`
Usage: strata stats [target-dir] [options]

Show tool latency percentiles, error rates, and telemetry statistics.

Options:
  -p, --path <dir>           Target directory (default: .)
  --json                     Output raw JSON
`);
      break;

    case 'serve':
      console.log(`
Usage: strata serve

Start MCP stdio daemon server for AI agent integrations.
`);
      break;

    default:
      printRootHelp();
      break;
  }
}

function toCamelCase(str: string): string {
  return str.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

export const BOOLEAN_FLAGS = new Set([
  'json',
  'version',
  'v',
  'help',
  'h',
  'yes',
  'y',
  'force',
  'f',
  'audit-events',
  'auditEvents',
  'include-pages',
  'includePages',
  'infer-props',
  'inferProps',
  'resolve-globals',
  'resolveGlobals',
]);

export function parseStringFlag(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (endOfFlags) {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      endOfFlags = true;
      continue;
    }

    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
      flags.v = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
      flags.h = true;
    } else if (arg === '-y' || arg === '--yes') {
      flags.yes = true;
      flags.y = true;
    } else if (arg === '-f' || arg === '--force') {
      flags.force = true;
      flags.f = true;
    } else if (arg === '-p') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags.path = next;
        flags.p = next;
        i++;
      } else {
        flags.path = true;
        flags.p = true;
      }
    } else if (arg.startsWith('--no-')) {
      const rawKey = arg.slice(5);
      const camelKey = toCamelCase(rawKey);
      flags[rawKey] = false;
      if (camelKey !== rawKey) {
        flags[camelKey] = false;
      }
    } else if (arg.startsWith('--')) {
      const equalsIdx = arg.indexOf('=');
      let key = arg.slice(2);
      let val: string | boolean = true;
      if (equalsIdx > 2) {
        key = arg.slice(2, equalsIdx);
        val = arg.slice(equalsIdx + 1);
      } else if (BOOLEAN_FLAGS.has(key)) {
        val = true;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          val = next;
          i++;
        }
      }
      const camelKey = toCamelCase(key);
      flags[key] = val;
      if (camelKey !== key) {
        flags[camelKey] = val;
      }
    } else if (arg.startsWith('-')) {
      const flagKey = arg.replace(/^-+/, '');
      flags[flagKey] = true;
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
  return parseAliasMapInput(raw);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];

  if (flags.version) {
    console.log(`strata v${STRATA_VERSION}`);
    return;
  }

  if (flags.help || !command || command === 'help') {
    const targetCommand = command === 'help' ? positional[1] : command;
    if (targetCommand) {
      printCommandHelp(targetCommand);
    } else {
      printRootHelp();
    }
    return;
  }

  const targetPath = typeof flags.path === 'string' && flags.path.trim() ? flags.path.trim() : '.';
  const isJson = Boolean(flags.json);

  try {
    if (command === 'serve') {
      const { runServer } = await import('./mcp');
      await runServer();
      return;
    }

    if (command === 'init') {
      if ('path' in flags && (flags.path === true || typeof flags.path !== 'string' || !flags.path.trim())) {
        console.error("Error: Flag '--path' requires a non-empty path argument.");
        process.exit(1);
      }
      if ('p' in flags && (flags.p === true || typeof flags.p !== 'string' || !flags.p.trim())) {
        console.error("Error: Flag '-p' requires a non-empty path argument.");
        process.exit(1);
      }
      if ('harness' in flags && (flags.harness === true || typeof flags.harness !== 'string' || !flags.harness.trim())) {
        console.error("Error: Flag '--harness' requires a valid harness value.");
        process.exit(1);
      }
      if ('agent' in flags && (flags.agent === true || typeof flags.agent !== 'string' || !flags.agent.trim())) {
        console.error("Error: Flag '--agent' requires a valid harness value.");
        process.exit(1);
      }
      const candidatePath = positional[1];
      if (candidatePath !== undefined && (!candidatePath || !candidatePath.trim())) {
        console.error("Error: Target workspace path cannot be empty.");
        process.exit(1);
      }
      const initPath = (candidatePath && !candidatePath.startsWith('-')) ? candidatePath : targetPath;
      await handleStrataInit({
        cwd: initPath,
        force: Boolean(flags.force || flags.f),
        harness: flags.harness ? String(flags.harness) : (flags.agent ? String(flags.agent) : undefined),
        yes: Boolean(flags.yes || flags.y),
      });
      return;
    }

    if (command === 'search' || command === 'find') {
      const componentName = parseStringFlag(flags.component ?? flags.componentName);
      if (componentName) {
        const usageTarget = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
        const scope =
          flags.scope === 'template' || flags.scope === 'script' || flags.scope === 'both'
            ? flags.scope
            : 'both';
        const matches = await findComponentUsage({
          componentName,
          targetPath: usageTarget,
          scope,
        });
        if (isJson) {
          console.log(JSON.stringify(matches, null, 2));
        } else {
          console.log(formatMatchesAsText(matches));
        }
        return;
      }

      const ruleInput = parseStringFlag(flags.rule);
      if (ruleInput) {
        const ruleTarget = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
        let ruleYaml = ruleInput;
        if (existsSync(ruleInput)) {
          ruleYaml = await readSourceFile(ruleInput);
        }
        const matches = await findCodeByRule({
          rule: ruleYaml,
          targetPath: ruleTarget,
        });
        if (isJson) {
          console.log(JSON.stringify(matches, null, 2));
        } else {
          console.log(formatMatchesAsText(matches));
        }
        return;
      }

      const pattern = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!pattern) {
        console.error('Error: Pattern is required for search command (e.g. strata find "<Button $PROPS />" or strata find --component Button).');
        process.exit(1);
      }

      const searchTarget = (positional[2] && !positional[2].startsWith('-')) ? positional[2] : targetPath;
      const matches = await findCode({
        pattern,
        targetPath: searchTarget,
        language: parseStringFlag(flags.lang) || 'ts',
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'find-component-usage' || command === 'usage') {
      const componentName = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!componentName) {
        console.error('Error: Component name is required.');
        process.exit(1);
      }

      const usageTarget = (positional[2] && !positional[2].startsWith('-')) ? positional[2] : targetPath;
      const scope =
        flags.scope === 'template' || flags.scope === 'script' || flags.scope === 'both'
          ? flags.scope
          : 'both';

      const matches = await findComponentUsage({
        componentName,
        targetPath: usageTarget,
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
      const ruleInput = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!ruleInput) {
        console.error('Error: Rule file or inline YAML is required.');
        process.exit(1);
      }

      const ruleTarget = (positional[2] && !positional[2].startsWith('-')) ? positional[2] : targetPath;
      let ruleYaml = ruleInput;
      if (existsSync(ruleInput)) {
        ruleYaml = await readSourceFile(ruleInput);
      }

      const matches = await findCodeByRule({
        rule: ruleYaml,
        targetPath: ruleTarget,
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'inspect' || command === 'contract' || command === 'extract-contract') {
      const filePath = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!filePath) {
        console.error('Error: Component file path is required.');
        process.exit(1);
      }
      if (!existsSync(filePath)) {
        console.error(`Error: File not found: "${filePath}".`);
        process.exit(1);
      }

      const symbol = parseStringFlag(flags.symbol ?? flags['symbol-name']);
      if (symbol) {
        const sliced = await sliceSymbol({ path: filePath, symbolName: symbol });
        if (!sliced) {
          console.error(`Error: Symbol "${symbol}" not found in "${filePath}".`);
          process.exit(1);
        }
        if (isJson) {
          console.log(JSON.stringify(sliced, null, 2));
        } else {
          console.log(formatSymbolSliceAsText(sliced));
        }
        return;
      }

      if (flags['audit-events']) {
        const auditRes = await auditEventHandlers({ path: filePath });
        if (isJson) {
          console.log(JSON.stringify(auditRes, null, 2));
        } else {
          console.log(formatEventHandlerAuditAsText(auditRes));
        }
        return;
      }

      const inferProps = flags['infer-props'] !== false;
      const resolveGlobals = flags['resolve-globals'] !== false;

      const contract = await extractComponentContract(filePath, {
        inferProps,
        resolveGlobals,
      });
      if (isJson) {
        console.log(JSON.stringify(contract, null, 2));
      } else {
        console.log(formatContractAsText(contract));
      }
      return;
    }

    if (command === 'tree' || command === 'component-tree') {
      const entryFile = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      const routePath = parseStringFlag(flags.route);

      if (!entryFile && !routePath) {
        console.error('Error: Either an entry file path or --route <path> is required.');
        process.exit(1);
      }
      if (entryFile && !existsSync(entryFile)) {
        console.error(`Error: Entry component file not found: "${entryFile}".`);
        process.exit(1);
      }

      const maxDepth = parseSafePositiveInt(flags.depth ?? flags['max-depth'] ?? flags.maxDepth, 3) ?? 3;
      const rawDir = String(flags.direction || '').toLowerCase();
      const direction = rawDir === 'upward' || rawDir === 'up' ? 'upward' : 'downward';
      const aliasMap = parseAliasMap(flags.alias || flags['alias-map'] || flags.aliasMap || flags.alias_map);
      const scopeFilter = parseStringFlag(
        flags['scope-filter'] ||
        flags.scopeFilter ||
        flags['scope-path'] ||
        flags.scopePath ||
        flags.scope_filter ||
        flags.scope_path
      );
      const result = await getComponentTree({
        entryPath: entryFile,
        routePath,
        targetPath: flags.path ? String(flags.path) : routePath ? targetPath : undefined,
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
      const scanPath = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
      const rawView = parseStringFlag(flags.view);
      const view = rawView === 'summary' || rawView === 'full' || rawView === 'tree' ? rawView : undefined;
      const result = await scanRoutes({
        targetPath: scanPath,
        frameworkHint: parseStringFlag(flags.framework) as RouteFramework | undefined,
        prefix: parseStringFlag(flags.prefix),
        view,
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
      const target = normalizeAuditTarget(flags.target, 'dead-components');
      if (!VALID_AUDIT_TARGETS.has(target)) {
        console.error(
          `Error: Invalid audit target "${flags.target}". Supported targets: ${[...VALID_AUDIT_TARGETS].join(', ')}`
        );
        process.exit(1);
      }
      const excludeDirs = parseStringList(flags['exclude-dirs'] ?? flags.excludeDirs ?? flags.exclude_dirs);
      const scopePath = (flags['scope-path'] || flags.scopePath || flags.scope_path || flags['scope-filter'] || flags.scopeFilter) as string | undefined;

      if (target === 'dead-state') {
        const result = await findUnusedState(auditPath, { scopePath, excludeDirs });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatUnusedStateAsText(result));
        }
        return;
      }

      if (target === 'routes') {
        const result = await scanRoutes({
          targetPath: auditPath,
          scopePath,
          excludeDirs,
          frameworkHint: flags.framework as RouteFramework | undefined,
          prefix: (flags.prefix as string) || undefined,
          view: (flags.view as 'summary' | 'full' | 'tree') || 'summary',
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatRoutesAsText(result));
        }
        return;
      }

      if (target === 'similar-templates') {
        const result = await findSimilarTemplates({
          targetPath: auditPath,
          scopePath,
          threshold: parseSafeFloat(flags.threshold),
          excludeDirs,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatSimilarTemplatesAsText(result));
        }
        return;
      }

      if (target === 'design-tokens' || target === 'design') {
        const result = await auditDesignTokens({
          targetPath: auditPath,
          scopePath,
          excludeDirs,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatDesignAuditAsText(result));
        }
        return;
      }

      if (target === 'bundle-health' || target === 'bundle') {
        const result = await auditBundleHealth({
          targetPath: auditPath,
          scopePath,
          excludeDirs,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBundleAuditAsText(result));
        }
        return;
      }

      if (target === 'api-contracts' || target === 'apis') {
        const result = await extractWorkspaceApiContracts({
          targetPath: auditPath,
          scopePath,
          excludeDirs,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatApiContractsAsText(result));
        }
        return;
      }

      if (target === 'archetype-drift' || target === 'archetype') {
        const exemplarFile = flags.exemplar
          ? String(flags.exemplar)
          : flags.exemplarPath
            ? String(flags.exemplarPath)
            : undefined;
        const result = await auditPageArchetypeDrift({
          targetPath: auditPath,
          exemplarPath: exemplarFile,
          workspaceRoot: resolveProjectRoot(auditPath),
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatArchetypeAuditAsText(result));
        }
        if (!result.conforms && !isJson) {
          process.exit(1);
        }
        return;
      }

      if (target === 'all') {
        const [routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts] =
          await Promise.all([
            scanRoutes({
              targetPath: auditPath,
              scopePath,
              excludeDirs,
              frameworkHint: flags.framework as RouteFramework | undefined,
              prefix: (flags.prefix as string) || undefined,
              view: (flags.view as 'summary' | 'full' | 'tree') || undefined,
            }),
            findUnusedComponents({
              targetPath: auditPath,
              scopePath,
              ignorePatterns: flags.ignore ? String(flags.ignore).split(',') : undefined,
              excludePages: flags['include-pages'] ? false : true,
              excludeDirs,
            }),
            findUnusedState(auditPath, { scopePath, excludeDirs }),
            findSimilarTemplates({
              targetPath: auditPath,
              scopePath,
              threshold: parseSafeFloat(flags.threshold),
              excludeDirs,
            }),
            auditDesignTokens({
              targetPath: auditPath,
              scopePath,
              excludeDirs,
            }),
            auditBundleHealth({
              targetPath: auditPath,
              scopePath,
              excludeDirs,
            }),
            extractWorkspaceApiContracts({
              targetPath: auditPath,
              scopePath,
              excludeDirs,
            }),
          ]);

        if (isJson) {
          console.log(
            JSON.stringify(
              { routes, unusedComponents, unusedState, similarTemplates, designSystemAudit, bundleAudit, apiContracts },
              null,
              2
            )
          );
        } else {
          const report = [
            '## Frontend Architecture & Health Audit',
            `Target: \`${auditPath}\`\n`,
            formatRoutesAsText(routes),
            '\n---\n',
            formatUnusedAsText(unusedComponents),
            '\n---\n',
            formatUnusedStateAsText(unusedState),
            '\n---\n',
            formatSimilarTemplatesAsText(similarTemplates),
            '\n---\n',
            formatDesignAuditAsText(designSystemAudit),
            '\n---\n',
            formatBundleAuditAsText(bundleAudit),
            '\n---\n',
            formatApiContractsAsText(apiContracts),
          ].join('\n');
          console.log(report);
        }
        return;
      }

      // Default target: dead-components
      const ignoreArg = flags.ignore ? String(flags.ignore).split(',') : undefined;
      const excludePages = flags['include-pages'] ? false : true;

      const result = await findUnusedComponents({
        targetPath: auditPath,
        ignorePatterns: ignoreArg,
        excludePages,
        excludeDirs,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatUnusedAsText(result));
      }
      return;
    }

    if (command === 'unused-state' || command === 'find-unused-state' || command === 'dead-state') {
      const auditPath = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
      const result = await findUnusedState(auditPath);

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatUnusedStateAsText(result));
      }
      return;
    }

    if (command === 'trace' || command === 'impact' || command === 'state-impact') {
      const identifier = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!identifier) {
        console.error('Error: State identifier (store, context, composable) is required.');
        process.exit(1);
      }

      const impactTarget = (positional[2] && !positional[2].startsWith('-')) ? positional[2] : targetPath;
      const depth = parseSafePositiveInt(flags.depth ?? flags['max-depth'] ?? flags.maxDepth, 1) ?? 1;
      const rawDirection = parseStringFlag(flags.direction)?.toLowerCase();
      const direction = (rawDirection as 'consumers' | 'dependencies' | 'both') || 'both';

      if (depth > 1 || rawDirection === 'dependencies' || rawDirection === 'both') {
        const result = await traceStateChain(impactTarget, {
          identifier,
          direction,
          maxDepth: depth,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatStateChainAsText(result));
        }
        return;
      }

      const role = (flags.role as 'all' | 'mutators' | 'readers') || 'all';
      const result = await queryStateImpact(impactTarget, identifier, role);
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatStateImpactAsText(result));
      }
      return;
    }

    if (command === 'sync') {
      const syncPath = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
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

    if (command === 'patch' || command === 'patch-plan') {
      const componentPath = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      if (!componentPath) {
        console.error('Error: Component file path is required for patch-plan (e.g. strata patch-plan src/Button.vue --refactor rename_prop --old type --new variant).');
        process.exit(1);
      }
      if (!existsSync(componentPath)) {
        console.error(`Error: Component file not found: "${componentPath}".`);
        process.exit(1);
      }

      const refactorType = (flags.refactor ?? flags['refactor-type'] ?? 'rename_prop') as PatchRefactorType;
      const oldName = parseStringFlag(flags.old ?? flags['old-name']);
      const newName = parseStringFlag(flags.new ?? flags['new-name']);

      if (!oldName) {
        console.error('Error: --old <name> is required.');
        process.exit(1);
      }

      if (refactorType.startsWith('rename_') && !newName) {
        console.error(`Error: --new <name> is required when --refactor is "${refactorType}".`);
        process.exit(1);
      }

      const result = await generatePatchPlan({
        componentPath,
        refactorType,
        oldName,
        newName,
        targetPath: flags.path ? String(flags.path) : undefined,
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
      const scanPath = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
      const scopePath = parseStringFlag(flags['scope-path'] || flags.scopePath);
      const excludeDirs = parseStringList(flags['exclude-dirs'] ?? flags.excludeDirs);

      const result = await extractWorkspaceApiContracts({
        targetPath: scanPath,
        scopePath,
        excludeDirs,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatApiContractsAsText(result));
      }
      return;
    }

    if (command === 'archetype') {
      const candidatePage = positional[1] && !positional[1].startsWith('-') ? positional[1] : undefined;
      const pageFile = candidatePage || (typeof flags.path === 'string' && flags.path !== '.' ? flags.path : undefined);
      if (!pageFile) {
        console.error(
          'Error: Target page file is required for archetype audit (e.g. strata archetype pages/orders/index.vue --exemplar pages/products/index.vue).'
        );
        process.exit(1);
      }
      if (!existsSync(pageFile)) {
        console.error(`Error: Target page file not found: "${pageFile}".`);
        process.exit(1);
      }

      const exemplarFile = parseStringFlag(flags.exemplar ?? flags.exemplarPath ?? flags['exemplar-path']);
      if (exemplarFile && !existsSync(exemplarFile)) {
        console.error(`Error: Exemplar file not found: "${exemplarFile}".`);
        process.exit(1);
      }

      const result = await auditPageArchetypeDrift({
        targetPath: pageFile,
        exemplarPath: exemplarFile,
        workspaceRoot: resolveProjectRoot(pageFile),
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatArchetypeAuditAsText(result));
      }
      if (!result.conforms) {
        process.exit(1);
      }
      return;
    }

    if (command === 'stats' || command === 'telemetry') {
      const scanPath = (positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath;
      const summary = StrataTelemetry.getSummary(scanPath);

      if (isJson) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(formatSummaryAsText(summary));
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
