#!/usr/bin/env bun
import { inspectFromCli } from './cli/inspect';
import { readSourceFile } from './engine/source-file';
import { mapFrontendScope, formatFrontendMapAsText } from './engine/frontend-map';
import { dumpSyntaxTree } from './engine/astgrep';
import { findCodeTool } from './tools/find-code';
import { existsSync, statSync } from 'node:fs';
import { findCodeByRule, findComponentUsage, formatMatchesAsText } from './engine/search';
import { getComponentTree, formatTreeAsText, formatTreeAsMermaid } from './engine/tree';
import { scanRoutes, formatRoutesAsText } from './engine/routes';
import { generatePatchPlan } from './engine/patch-plan';
import { extractWorkspaceApiContracts, formatApiContractsAsText } from './engine/api-contract';
import { formatStateImpactAsText, formatUnusedStateAsText, findUnusedState, queryStateImpact, syncWorkspace, closeAllDatabases, traceStateChain, formatStateChainAsText } from './engine/database';
import { handleStrataInit } from './cli/commands/init';
import { normalizeAuditTarget, parseAliasMapInput, parseSafePositiveInt, parseStringList, VALID_AUDIT_TARGETS } from './engine/path-resolver';
import { STRATA_VERSION } from './version';
import { StrataTelemetry, formatSummaryAsText } from './engine/telemetry';
import type { PatchRefactorType, RouteFramework } from './types';
import { printRootHelp, printCommandHelp } from './cli/help';
import { parseStringFlag, parseArgs } from './cli/arguments';
import { analyzeFrontend, formatFrontendAudit, type AuditTarget } from './engine/frontend-audit';

export { printRootHelp } from './cli/help';
export { printCommandHelp } from './cli/help';
export { BOOLEAN_FLAGS } from './cli/arguments';
export { parseStringFlag } from './cli/arguments';

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
      if (flags['dump-ast'] || flags.dumpAst) {
        const snippet = positional[1];
        if (!snippet) {
          console.error('Error: Code snippet is required with --dump-ast (e.g. strata find "const a = 1" --dump-ast).');
          process.exit(1);
        }
        const tree = await dumpSyntaxTree(snippet, parseStringFlag(flags.lang) || 'ts');
        console.log(isJson ? JSON.stringify({ tree }, null, 2) : tree);
        return;
      }
      if (flags.map) {
        const map = await mapFrontendScope((positional[1] && !positional[1].startsWith('-')) ? positional[1] : targetPath, {
          limit: parseSafePositiveInt(flags.limit, 100),
          offset: parseSafePositiveInt(flags.offset, 0) ?? 0,
          excludeDirs: parseStringList(flags['exclude-dirs'] ?? flags.excludeDirs),
        });
        console.log(isJson ? JSON.stringify(map, null, 2) : formatFrontendMapAsText(map));
        return;
      }
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
      const result = await findCodeTool.handler({
        path: searchTarget,
        pattern,
        language: parseStringFlag(flags.lang) || 'ts',
        mode: flags.mode || 'ast',
        max_results: parseSafePositiveInt(flags.limit, 200),
        format: isJson ? 'json' : 'text',
      });
      if (result.isError) throw new Error(result.content[0]?.text ?? 'Search failed');
      console.log(result.content[0]?.text ?? '');
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
      if (statSync(filePath).isDirectory()) {
        console.error(`Error: "${filePath}" is a directory. Provide a path to a component file, or use "strata audit" / "strata tree" to inspect directories.`);
        process.exit(1);
      }

      await inspectFromCli(filePath, flags, isJson);
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

      const isMermaid = flags.export === 'mermaid' || Boolean(flags.mermaid) || Boolean(flags.m);
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else if (isMermaid) {
        console.log(formatTreeAsMermaid(result));
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
      const analysis = await analyzeFrontend({
        target: target as AuditTarget, targetPath: auditPath,
        scopePath: parseStringFlag(flags['scope-path'] || flags.scopePath || flags.scope_path || flags['scope-filter'] || flags.scopeFilter),
        excludeDirs: parseStringList(flags['exclude-dirs'] ?? flags.excludeDirs ?? flags.exclude_dirs),
        ignorePatterns: flags.ignore ? String(flags.ignore).split(',') : undefined,
        includePages: Boolean(flags['include-pages']), frameworkHint: flags.framework as RouteFramework | undefined,
        prefix: parseStringFlag(flags.prefix), view: parseStringFlag(flags.view) as 'summary' | 'full' | 'tree' | undefined,
      });
      console.log(isJson ? JSON.stringify(analysis.data, null, 2) : formatFrontendAudit(analysis, auditPath));
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
      const role = (flags.role as 'all' | 'mutators' | 'readers') || 'all';

      if (depth > 1 || rawDirection === 'dependencies' || rawDirection === 'both') {
        const result = await traceStateChain(impactTarget, {
          identifier,
          direction,
          maxDepth: depth,
          role,
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatStateChainAsText(result));
        }
        return;
      }

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
