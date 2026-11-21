

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
  find, search <pattern>         AST code search (--component, --rule, --lang, --mode)
  inspect, contract <file>       Inspect component (--view map|source, --symbol, --outline)
  tree, component-tree [entry]   Inspect component hierarchy tree (--route, --direction)
  trace, impact <state-id>       Trace state blast radius and consumers (--depth, --role)
  audit [dir]                    Inspect topology and unused candidates (--target)
  patch, patch-plan <file>       Generate prescriptive refactoring patch plan
  stats, telemetry [dir]         Show tool latency, error rates, and telemetry stats

Direct Shortcuts:
  routes, apis, dead-state, usage, rule

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
  --harness, --agent <name>  Target harness (antigravity | claude | codex | opencode | agents | all)
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
  --mode <mode>              Pattern mode: ast | auto | literal
  --map                      Return bounded frontend inventory (no source bodies)
  --limit <n>                Result/page size (default: 100 for map, 200 for search)
  --offset <n>               Zero-based inventory offset
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
  --view <map|source>        Map regions or return a map-selected source slice
  --source-ref <json>        Source ref copied from --view map output
  --source-range <start:end> Return inclusive source lines (optional --expected-hash)
  --symbol <name>            Extract specific symbol or function with line numbers
  --outline                  Extract component symbol outline
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
      console.log(`
Usage: strata audit [target-dir] [options]

Inspect route/API topology and unused component/state candidates.

Targets (--target <target>):
  dead-components (default)  Find unreferenced components
  dead-state                 Detect unused reactive state / stores
  routes                     Extract client-side route manifest
  api-contracts              Extract outbound API endpoint calls
  all                        Run the four retained audit targets

Options:
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
