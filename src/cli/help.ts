export function printRootHelp() {
  console.log(`
strata — Static and Semantic Code Analysis CLI for Frontend & Fullstack JS/TS Projects

Usage:
  strata <command> [options]
  strata <command> --help        Show options for a specific command

Operational Commands:
  serve                          Start MCP stdio daemon server
  init [dir]                     Initialize .strata/graph.db, MCP configs, and agent skills
  sync [dir]                     Run incremental index sync
  stats [dir]                    Show tool latency, error rates, and telemetry stats

Analysis Commands (1:1 with MCP Tools):
  map [dir]                      Map projects, frameworks, routes, files, or health candidates
  inspect <file>                 Inspect file outline, resolved props/slots contract, and HTTP boundaries
  graph <query> [file]           Query definition|references|call_hierarchy|component_tree|state_flow|impact
  read [file]                    Read bounded, hash-verified source slice (--ref, --symbol-id, --symbol, --block, --lines)
  search <query>                 Search symbols (FTS5), component_usage, prop_usage, or text

Global Options:
  -p, --path <dir|file>          Workspace root or target path (default: .)
  -v, --version                  Show version number
  --json                         Output structured JSON instead of compact text
  -h, --help                     Show help message
`);
}

export function printCommandHelp(command: string) {
  switch (command) {
    case 'init':
      console.log(`
Usage: strata init [target-dir] [options]

Initialize .strata/graph.db (Schema v3), local MCP configs, and agent skills.

Options:
  --harness, --agent <name>  Target harness (antigravity | claude | codex | opencode | agents | all)
  -f, --force                Overwrite existing agent rules and configurations
  -y, --yes                  Skip interactive prompts, auto-accept defaults
  -p, --path <dir>           Target directory (default: .)
`);
      break;

    case 'sync':
      console.log(`
Usage: strata sync [target-dir] [options]

Run incremental index sync on the workspace or a specific project package.

Options:
  --package <key>            Sync only one project/package (e.g. frontend, apps/web)
  -f, --force                Force full re-extraction
  --json                     Output raw JSON stats
`);
      break;

    case 'map':
      console.log(`
Usage: strata map [target-dir] [options]

Orient in a frontend workspace or monorepo without reading file bodies.

Options:
  --view <view>              overview | packages | routes | files | health (default: overview)
  --package <key>            Filter to one monorepo package
  --prefix <path>            Filter relative directory prefix (view=files)
  --limit <n>                Page size (default: 100)
  --cursor <token>           Pagination cursor
  --json                     Output structured JSON
`);
      break;

    case 'inspect':
      console.log(`
Usage: strata inspect <file> [options]

Inspect file outline, TypeChecker-resolved props/slots contract, render boundary, and HTTP boundaries.

Options:
  --sections <csv>           outline,contract,boundaries,imports
  --no-types                 Skip TypeScript TypeChecker prop expansion
  -p, --path <dir>           Workspace root (default: .)
  --json                     Output structured JSON
`);
      break;

    case 'graph':
      console.log(`
Usage: strata graph <query> [file] [options]

Query code relationships across files and monorepo packages.
Queries: definition | references | call_hierarchy | component_tree | state_flow | impact

Options:
  --file <path>              Target file path
  --symbol <name>            Target symbol or state identifier
  --symbol-id <id>           Stable symbolId handle
  --member <name>            Prop, event, slot, or member name
  --direction <up|down|both> Traversal direction (default: up)
  --package <csv>            Restrict scope to package key(s)
  --depth <n>                Max traversal depth (default: 4)
  --limit <n>                Page size (default: 30)
  --cursor <token>           Pagination cursor
  -p, --path <dir>           Workspace root (default: .)
  --json                     Output structured JSON
`);
      break;

    case 'read':
      console.log(`
Usage: strata read [file] [options]

Read a bounded, hash-verified source slice.

Options:
  --ref <sourceRef>          Hash-verified sourceRef handle
  --symbol-id <id>           Stable symbolId handle
  --symbol <name>            Symbol name inside file
  --block <kind>             script | scriptSetup | template | style
  --lines <start:end>        1-based inclusive line range
  --max-lines <n>            Max lines returned (default: 80)
  -p, --path <dir>           Workspace root (default: .)
`);
      break;

    case 'search':
      console.log(`
Usage: strata search <query> [options]

In-process code discovery (FTS5 symbols, component usages, prop usages, or scoped text).

Options:
  --kind <kind>              symbol | component_usage | prop_usage | text (default: symbol)
  --package <key>            Filter to one monorepo package
  --prefix <path>            Filter relative directory prefix
  --limit <n>                Page size (default: 30)
  --cursor <token>           Pagination cursor
  -p, --path <dir>           Workspace root (default: .)
  --json                     Output structured JSON
`);
      break;

    case 'stats':
    case 'telemetry':
      console.log(`
Usage: strata stats [target-dir] [options]

Show local Strata MCP telemetry summary (latency, tokens, error rate).

Options:
  --days <n>                 Rolling window in days (default: 7)
  --json                     Output raw JSON
`);
      break;

    default:
      printRootHelp();
      break;
  }
}
