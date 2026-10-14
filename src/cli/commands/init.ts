import { readSourceFile } from '../../engine/source-file';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL, STRATA_POST_WRITE_HOOK } from '../templates';
import { syncWorkspace } from '../../engine/database';
import { resolveProjectRoot } from '../../engine/path-resolver';
import { setupHarnessConfigs, type AgentHarness } from '../mcp-configs';
import { STRATA_VERSION } from '../../version';

export interface StrataInitOptions {
  cwd?: string;
  force?: boolean;
  harness?: string;
  yes?: boolean;
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
 */
function parseHarnessArg(arg?: string): AgentHarness[] {
  if (!arg) return ['all'];
  const normalized = arg.toLowerCase().trim();
  switch (normalized) {
    case '1':
    case 'claude':
    case 'claude-code':
      return ['claude'];
    case '2':
    case 'cursor':
      return ['cursor'];
    case '3':
    case 'vscode':
    case 'vs-code':
    case 'codex':
      return ['vscode'];
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
      return ['pi'];
    case '8':
    case 'all':
      return ['all'];
    case '9':
    case 'skip':
    case 'none':
      return ['skip'];
    default:
      return ['all'];
  }
}

/**
 * Interactive prompt for selecting agent harness when running in a TTY.
 */
async function promptHarnessChoice(): Promise<AgentHarness[]> {
  console.log(`?  Select AI Agent Harness to configure for this project:`);
  console.log(`   [1] Claude Code        (.mcp.json)`);
  console.log(`   [2] Cursor / Codex     (.cursor/mcp.json)`);
  console.log(`   [3] VS Code            (.vscode/mcp.json)`);
  console.log(`   [4] OpenCode           (opencode.json)`);
  console.log(`   [5] Google Antigravity (.agents/skills + rules)`);
  console.log(`   [6] Goose              (.goose/mcp.json)`);
  console.log(`   [7] Pi / Oh My Pi      (.pi/mcp.json)`);
  console.log(`   [8] All (Multi-Harness - recommended)`);
  console.log(`   [9] Skip MCP Config    (Rules & SQLite index only)\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Enter choice [1-9] (default: 8): ');
    const choice = answer.trim() || '8';
    return parseHarnessArg(choice);
  } finally {
    rl.close();
  }
}

export async function handleStrataInit(options: StrataInitOptions = {}): Promise<void> {
  const cwd = options.cwd ? resolveProjectRoot(options.cwd) : process.cwd();
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
  let selectedHarnesses: AgentHarness[];
  if (options.harness) {
    selectedHarnesses = parseHarnessArg(options.harness);
  } else if (options.yes || !process.stdin.isTTY) {
    selectedHarnesses = ['all'];
  } else {
    selectedHarnesses = await promptHarnessChoice();
  }

  console.log(`\n${cyan}◇${reset}  Creating local project structure & agent artifacts:`);

  // 1. Prepare directory structure for agent harness & cache
  const agentsDir = join(cwd, '.agents');
  const rulesDir = join(agentsDir, 'rules');
  const skillsDir = join(agentsDir, 'skills', 'strata-inspect');
  const hooksDir = join(agentsDir, 'hooks');
  const strataDir = join(cwd, '.strata');

  await fs.mkdir(rulesDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(strataDir, { recursive: true });

  console.log(`${cyan}│${reset}  ${green}✔${reset} .strata/                   ${dim}(Isolated SQLite graph cache)${reset}`);

  // 2. Write agent harness rules, skills, and hooks (respecting --force)
  const targets = [
    { label: '.agents/rules/strata-frontend.md', path: join(rulesDir, 'strata-frontend.md'), content: STRATA_FRONTEND_RULE },
    { label: '.agents/skills/strata-inspect/SKILL.md', path: join(skillsDir, 'SKILL.md'), content: STRATA_INSPECT_SKILL },
    { label: '.agents/hooks/strata-post-write.sh', path: join(hooksDir, 'strata-post-write.sh'), content: STRATA_POST_WRITE_HOOK, mode: 0o755 },
  ];

  for (const t of targets) {
    if (!force && existsSync(t.path)) {
      console.log(`${cyan}│${reset}  ${dim}• Skipped existing: ${t.label} (use --force to overwrite)${reset}`);
    } else {
      await fs.writeFile(t.path, t.content, t.mode ? { encoding: 'utf8', mode: t.mode } : 'utf8');
      console.log(`${cyan}│${reset}  ${green}✔${reset} ${t.label}`);
    }
  }

  // 3. Update or create .gitignore
  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = await readSourceFile(gitignorePath);
    if (!content.includes('.strata')) {
      await fs.appendFile(gitignorePath, '\n# Strata AST cache\n.strata/\n', 'utf8');
      console.log(`${cyan}│${reset}  ${green}✔${reset} .gitignore                 ${dim}(Added .strata/ entry)${reset}`);
    }
  } else {
    await fs.writeFile(gitignorePath, '# Strata AST cache\n.strata/\n', 'utf8');
    console.log(`${cyan}│${reset}  ${green}✔${reset} .gitignore                 ${dim}(Created with .strata/ entry)${reset}`);
  }

  // 4. Generate local project MCP configurations
  const configResults = await setupHarnessConfigs(cwd, selectedHarnesses);
  if (configResults.length > 0) {
    console.log(`${cyan}│${reset}`);
    console.log(`${cyan}◇${reset}  Configuring local Agent Harness & MCP settings:`);
    for (const res of configResults) {
      const actionText = res.action === 'updated' ? 'merged/updated' : 'configured';
      console.log(`${cyan}│${reset}  ${green}✔${reset} ${res.file.padEnd(25)} ${dim}(${res.harness} ${actionText})${reset}`);
    }
  }

  // 5. Initial Workspace Sync
  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}◇${reset}  Indexing frontend components:`);
  const stats = await syncWorkspace(cwd);
  console.log(`${cyan}│${reset}  ${green}✔${reset} Indexed ${stats.total} components into .strata/graph.db in ${stats.durationMs}ms`);

  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}└${reset}  ${bold}${green}Initialization complete!${reset} Your project is equipped with Strata AST intelligence. 🚀`);
  console.log(`   You can now run your AI agent in this directory (e.g. ${cyan}claude${reset}, ${cyan}cursor${reset}, ${cyan}opencode${reset}).\n`);
}
