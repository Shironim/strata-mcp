import { readSourceFile } from '../../engine/source-file';
import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { syncWorkspace } from '../../engine/database';
import { setupHarnessConfigs, setupHarnessArtifacts, type AgentHarness } from '../mcp-configs';
import { STRATA_VERSION } from '../../version';

export interface StrataInitOptions {
  cwd?: string;
  force?: boolean;
  harness?: string;
  yes?: boolean;
}

/**
 * Checks whether .gitignore already has an active, non-negated rule for .strata.
 */
function hasActiveStrataIgnore(content: string): boolean {
  const lines = content.split('\n');
  let hasIgnore = false;
  let hasNegation = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (
      line === '!.strata' ||
      line === '!.strata/' ||
      line === '!/.strata' ||
      line === '!/.strata/' ||
      line === '!**/.strata' ||
      line === '!**/.strata/'
    ) {
      hasNegation = true;
    } else if (
      line === '.strata' ||
      line === '.strata/' ||
      line === '/.strata' ||
      line === '/.strata/' ||
      line === '**/.strata' ||
      line === '**/.strata/'
    ) {
      hasIgnore = true;
      hasNegation = false;
    }
  }
  return hasIgnore && !hasNegation;
}

/**
 * Detects the primary frontend framework from package.json if present.
 */
async function detectProjectFramework(projectRoot: string): Promise<string> {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return 'Generic Workspace';
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.nuxt) return 'Nuxt (Vue 3)';
    if (deps.next) return 'Next.js (React)';
    if (deps.astro) return 'Astro';
    if (deps.vue) return 'Vue 3 / SFC';
    if (deps.react) return 'React';
    if (deps.svelte) return 'Svelte';
    return 'JavaScript / TypeScript Project';
  } catch {
    return 'Frontend Workspace';
  }
}

/**
 * Parses user input or CLI flags into recognized AgentHarness entries.
 * Throws actionable error for unrecognized harness values (INIT-09).
 */
export function parseHarnessArg(arg?: string): AgentHarness[] {
  if (!arg) return ['all'];
  const normalized = arg.toLowerCase().trim();
  if (!normalized) return ['all'];
  switch (normalized) {
    case '1':
    case 'claude':
    case 'claude-code':
      return ['claude'];
    case '2':
    case 'cursor':
      return ['cursor'];
    case '3':
    case 'codex':
    case 'openai-codex':
      return ['codex'];
    case '4':
    case 'opencode':
      return ['opencode'];
    case '5':
    case 'antigravity':
    case 'gemini':
      return ['antigravity'];
    case '6':
    case 'goose':
      return ['goose'];
    case '7':
    case 'pi':
    case 'oh-my-pi':
    case 'ohmypi':
    case 'omp':
      return ['pi'];
    case '8':
    case 'all':
      return ['all'];
    case '9':
    case 'skip':
    case 'none':
      return ['skip'];
    default:
      throw new Error(
        `Unknown agent harness: '${arg}'. Valid options: claude, cursor, codex, opencode, antigravity, goose, pi, omp, all, skip (or 1-9)`
      );
  }
}

/**
 * Interactive prompt for selecting agent harness when running in a TTY.
 */
async function promptHarnessChoice(): Promise<AgentHarness[]> {
  console.log(`?  Select AI Agent Harness to configure for this project:`);
  console.log(`   [1] Claude Code        (.mcp.json, .claude/settings.json, CLAUDE.md)`);
  console.log(`   [2] Cursor             (.cursor/mcp.json, .cursor/hooks.json, .cursor/rules/)`);
  console.log(`   [3] OpenAI Codex       (.codex/config.toml & AGENTS.md)`);
  console.log(`   [4] OpenCode           (opencode.json, AGENTS.md, .agents/skills/)`);
  console.log(`   [5] Google Antigravity (.gemini/mcp_config.json, GEMINI.md, .gemini/skills/)`);
  console.log(`   [6] Goose              (.goose/mcp.json & .goosehints)`);
  console.log(`   [7] Pi / Oh My Pi      (.pi/ & .omp/ mcp.json & AGENTS.md)`);
  console.log(`   [8] All (Multi-Harness - recommended)`);
  console.log(`   [9] Skip MCP Config    (Rules & SQLite index only)\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Enter choice [1-9] (default: 8): ');
    const choice = answer.trim() || '8';
    return parseHarnessArg(choice);
  } finally {
    rl.close();
    if (typeof input.pause === 'function') {
      input.pause();
    }
  }
}

export async function handleStrataInit(options: StrataInitOptions = {}): Promise<void> {
  const rawTarget = options.cwd ?? '.';
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
    throw new Error('Target workspace path cannot be empty.');
  }
  const cwd = resolve(process.cwd(), rawTarget);
  const force = Boolean(options.force);
  const framework = await detectProjectFramework(cwd);

  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log(`\n${cyan}◆${reset}  ${bold}strata init v${STRATA_VERSION}${reset}`);
  console.log(`${cyan}│${reset}  Frontend Structural AST Intelligence & Local MCP Engine`);
  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}◇${reset}  Target Workspace: ${bold}${cwd}${reset}`);
  console.log(`${cyan}│${reset}  • Detected: ${green}${framework}${reset}\n`);

  // Determine harnesses to configure
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.BUN_TEST);
  const isCI = Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);
  let selectedHarnesses: AgentHarness[];
  if (options.harness) {
    selectedHarnesses = parseHarnessArg(options.harness);
  } else if (options.yes || !process.stdin.isTTY || isTest || isCI) {
    selectedHarnesses = ['all'];
  } else {
    selectedHarnesses = await promptHarnessChoice();
  }

  console.log(`\n${cyan}◇${reset}  Creating local project structure & agent artifacts:`);

  // 1. Prepare directory structure for graph cache
  const strataDir = join(cwd, '.strata');
  await fs.mkdir(strataDir, { recursive: true });

  console.log(`${cyan}│${reset}  ${green}✔${reset} .strata/                   ${dim}(Isolated SQLite graph cache)${reset}`);

  // 2. Write agent harness rules, skills, and hooks (respecting selected harness & --force)
  const artifactResults = await setupHarnessArtifacts(cwd, selectedHarnesses, force);
  for (const art of artifactResults) {
    if (art.action === 'skipped') {
      console.log(`${cyan}│${reset}  ${dim}• Skipped existing: ${art.file} (use --force to overwrite)${reset}`);
    } else {
      const actionText = art.action === 'updated' ? 'merged/updated' : 'configured';
      console.log(`${cyan}│${reset}  ${green}✔${reset} ${art.file.padEnd(35)} ${dim}(${art.harness} ${actionText})${reset}`);
    }
  }

  // 3. Update or create .gitignore (INIT-11)
  const strataGitignore = join(strataDir, '.gitignore');
  if (!existsSync(strataGitignore)) {
    await fs.writeFile(strataGitignore, '*\n', 'utf8');
  }

  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = await readSourceFile(gitignorePath);
    if (!hasActiveStrataIgnore(content)) {
      await fs.appendFile(gitignorePath, '\n# Strata AST cache\n.strata/\n', 'utf8');
      console.log(`${cyan}│${reset}  ${green}✔${reset} .gitignore                 ${dim}(Added .strata/ entry)${reset}`);
    }
  } else {
    await fs.writeFile(gitignorePath, '# Strata AST cache\n.strata/\n', 'utf8');
    console.log(`${cyan}│${reset}  ${green}✔${reset} .gitignore                 ${dim}(Created with .strata/ entry)${reset}`);
  }

  // 4. Generate local project MCP configurations (INIT-02, INIT-06, INIT-08)
  const configResults = await setupHarnessConfigs(cwd, selectedHarnesses, force);
  if (configResults.length > 0) {
    console.log(`${cyan}│${reset}`);
    console.log(`${cyan}◇${reset}  Configuring local Agent Harness & MCP settings:`);
    for (const res of configResults) {
      if (res.action === 'failed') {
        console.error(`${cyan}│${reset}  \x1b[31m✕\x1b[0m ${res.file.padEnd(25)} ${dim}(${res.harness} failed: ${res.error || 'configuration error'})${reset}`);
      } else if (res.action === 'skipped') {
        console.log(`${cyan}│${reset}  ${dim}• ${res.file.padEnd(25)} (${res.harness} skipped - already configured)${reset}`);
      } else {
        const actionText = res.action === 'updated' ? 'merged/updated' : 'configured';
        console.log(`${cyan}│${reset}  ${green}✔${reset} ${res.file.padEnd(25)} ${dim}(${res.harness} ${actionText})${reset}`);
      }
    }

    const failedConfigs = configResults.filter(r => r.action === 'failed');
    if (failedConfigs.length > 0) {
      console.error(`${cyan}│${reset}`);
      console.error(`${cyan}│${reset}  \x1b[1;31m✕ Configuration failed for ${failedConfigs.length} harness config(s)\x1b[0m`);
      console.error(`${cyan}│${reset}  \x1b[1mPartial Initialization State:\x1b[0m`);
      console.error(`${cyan}│${reset}    ✓ Agent harness rules, skills & hooks: Scaffolding complete`);
      console.error(`${cyan}│${reset}    ✕ Local MCP configurations: Incomplete / corrupt files`);
      console.error(`${cyan}│${reset}    - Frontend component graph: Not yet indexed`);
      console.error(`${cyan}│${reset}`);
      throw new Error(`Configuration failed for harness: ${failedConfigs.map(f => `${f.file} (${f.error || 'malformed'})`).join(', ')}`);
    }
  }

  // 5. Initial Workspace Sync
  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}◇${reset}  Indexing frontend components:`);
  try {
    const stats = await syncWorkspace(cwd);
    console.log(`${cyan}│${reset}  ${green}✔${reset} Indexed ${stats.total} components into .strata/graph.db in ${stats.durationMs}ms`);
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    let failurePhase = 'AST Component Indexing';
    let recoveryInstruction = "Inspect error trace, verify component syntax, then run 'strata sync' to rebuild graph cache.";

    if (rawMessage.includes('database') || rawMessage.includes('SQLite') || rawMessage.includes('locked') || rawMessage.includes('busy')) {
      failurePhase = 'Database Access';
      recoveryInstruction = "Ensure no other process is locking '.strata/graph.db', then run 'strata sync'.";
    } else if (rawMessage.includes('parse') || rawMessage.includes('SyntaxError')) {
      failurePhase = 'Component Parser';
      recoveryInstruction = "Check invalid syntax in frontend templates, then run 'strata sync'.";
    } else if (rawMessage.includes('EACCES') || rawMessage.includes('permission')) {
      failurePhase = 'Filesystem Permissions';
      recoveryInstruction = "Check read/write permissions for '.strata/' and project root, then re-run 'strata init'.";
    }

    console.error(`${cyan}│${reset}`);
    console.error(`${cyan}│${reset}  \x1b[1;31m✕ Initial component indexing failed (${failurePhase})\x1b[0m`);
    console.error(`${cyan}│${reset}  \x1b[1mPartial Initialization State:\x1b[0m`);
    console.error(`${cyan}│${reset}    ✓ Agent harness rules, skills & hooks: Scaffolding complete`);
    console.error(`${cyan}│${reset}    ✓ Local MCP configurations: Configured`);
    console.error(`${cyan}│${reset}    ✕ Frontend component graph: Incomplete`);
    console.error(`${cyan}│${reset}`);
    console.error(`${cyan}│${reset}  \x1b[1;31mError Details:\x1b[0m ${rawMessage}`);
    console.error(`${cyan}│${reset}  \x1b[1;33mRecovery Instruction:\x1b[0m ${recoveryInstruction}`);
    console.error(`${cyan}│${reset}`);

    throw new Error(`Initial indexing failed (${failurePhase}): ${rawMessage}. ${recoveryInstruction}`);
  }

  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}└${reset}  ${bold}${green}Initialization complete!${reset} Your project is equipped with Strata AST intelligence. 🚀`);
  console.log(`   You can now run your AI agent in this directory (e.g. ${cyan}claude${reset}, ${cyan}cursor${reset}, ${cyan}opencode${reset}).\n`);
}
