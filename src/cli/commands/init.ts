import { readSourceFile } from '../../engine/source-file';
import { existsSync, promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { iterateFiles } from '../../engine/collector';
import { defaultWarmDbPool, syncWorkspaceV3 } from '../../engine/v2';
import { StrataTelemetry } from '../../engine/telemetry';
import { setupHarnessConfigs, setupHarnessArtifacts, type AgentHarness } from '../mcp-configs';
import { STRATA_VERSION } from '../../version';
import {
  classifySyncError,
  createSyncProgressReporter,
  formatSyncDuration,
} from '../ui/sync-progress';

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

export interface DetectedProjectProfile {
  label: string;
  isUiProject: boolean;
}

const UI_FRAMEWORK_DEPS: Array<{ pkg: string; label: string }> = [
  { pkg: 'nuxt', label: 'Nuxt (Vue 3)' },
  { pkg: 'nuxt3', label: 'Nuxt (Vue 3)' },
  { pkg: '@nuxt/kit', label: 'Nuxt (Vue 3)' },
  { pkg: 'next', label: 'Next.js (React)' },
  { pkg: 'astro', label: 'Astro' },
  { pkg: 'vue', label: 'Vue 3 / SFC' },
  { pkg: '@inertiajs/vue3', label: 'Inertia (Vue 3)' },
  { pkg: '@inertiajs/react', label: 'Inertia (React)' },
  { pkg: '@inertiajs/svelte', label: 'Inertia (Svelte)' },
  { pkg: 'react', label: 'React' },
  { pkg: 'react-dom', label: 'React' },
  { pkg: 'svelte', label: 'Svelte' },
  { pkg: '@sveltejs/kit', label: 'SvelteKit' },
  { pkg: 'solid-js', label: 'SolidJS' },
  { pkg: 'preact', label: 'Preact' },
  { pkg: '@angular/core', label: 'Angular' },
];

const UI_SOURCE_EXTENSIONS = new Set(['.vue', '.svelte', '.astro', '.tsx', '.jsx']);
const SCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * Detects whether the workspace uses a UI frontend framework or is a non-UI TypeScript/JavaScript project.
 */
export async function detectProjectProfile(projectRoot: string): Promise<DetectedProjectProfile> {
  const pkgPath = join(projectRoot, 'package.json');
  let hasPackageJson = false;
  let hasPkgScriptSignals = false;

  if (existsSync(pkgPath)) {
    hasPackageJson = true;
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const candidate of UI_FRAMEWORK_DEPS) {
        if (deps[candidate.pkg]) {
          return { label: candidate.label, isUiProject: true };
        }
      }
      hasPkgScriptSignals = Boolean(
        deps.typescript || deps['@types/node'] || deps['bun-types'] || pkg.main || pkg.bin || pkg.exports || pkg.type === 'module'
      );
    } catch {
      // Ignore malformed package.json and continue with file inspection
    }
  }

  let hasUiFiles = false;
  let hasScriptFiles = false;
  try {
    for await (const file of iterateFiles(projectRoot)) {
      const ext = extname(file).toLowerCase();
      if (UI_SOURCE_EXTENSIONS.has(ext)) {
        hasUiFiles = true;
        break;
      }
      if (SCRIPT_SOURCE_EXTENSIONS.has(ext)) {
        hasScriptFiles = true;
      }
    }
  } catch {
    // Graceful fallback when workspace is unreadable or uninitialized
  }

  if (hasUiFiles) {
    return { label: 'Frontend Workspace', isUiProject: true };
  }

  const hasTsConfig = existsSync(join(projectRoot, 'tsconfig.json'));
  if (hasPackageJson || hasTsConfig || hasScriptFiles || hasPkgScriptSignals) {
    return { label: 'TypeScript / JavaScript Project (Non-UI)', isUiProject: false };
  }

  return { label: 'Generic Workspace', isUiProject: true };
}

/**
 * Detects existing client harness directories/configurations in the workspace.
 */
export function detectExistingHarnesses(projectRoot: string): Exclude<AgentHarness, 'all' | 'skip'>[] {
  const detected: Exclude<AgentHarness, 'all' | 'skip'>[] = [];
  if (existsSync(join(projectRoot, '.gemini')) || existsSync(join(projectRoot, 'GEMINI.md'))) {
    detected.push('antigravity');
  }
  if (
    existsSync(join(projectRoot, '.claude')) ||
    existsSync(join(projectRoot, 'CLAUDE.md')) ||
    existsSync(join(projectRoot, '.mcp.json'))
  ) {
    detected.push('claude');
  }
  if (existsSync(join(projectRoot, '.codex'))) {
    detected.push('codex');
  }
  if (existsSync(join(projectRoot, 'opencode.json')) || existsSync(join(projectRoot, 'opencode'))) {
    detected.push('opencode');
  }
  if (existsSync(join(projectRoot, '.agents'))) {
    detected.push('agents');
  }
  return detected;
}

/**
 * Parses user input or CLI flags into recognized AgentHarness entries.
 * Focused exclusively on: Antigravity (.gemini), Claude Code (.claude), Codex (.codex),
 * Opencode (opencode/), and .agents (general).
 */
export function parseHarnessArg(arg?: string): AgentHarness[] {
  if (!arg) return ['all'];
  const normalized = arg.toLowerCase().trim();
  if (!normalized) return ['all'];
  switch (normalized) {
    case '1':
    case 'antigravity':
    case 'gemini':
      return ['antigravity'];
    case '2':
    case 'claude':
    case 'claude-code':
      return ['claude'];
    case '3':
    case 'codex':
    case 'openai-codex':
      return ['codex'];
    case '4':
    case 'opencode':
      return ['opencode'];
    case '5':
    case 'agents':
    case '.agents':
    case 'general':
      return ['agents'];
    case '6':
    case 'all':
      return ['all'];
    case '7':
    case 'skip':
    case 'none':
      return ['skip'];
    default:
      throw new Error(
        `Unknown agent harness: '${arg}'. Valid options: antigravity, claude, codex, opencode, agents, all, skip (or 1-7)`
      );
  }
}

/**
 * Interactive prompt for selecting agent harness when running in a TTY.
 */
async function promptHarnessChoice(detected: Exclude<AgentHarness, 'all' | 'skip'>[] = []): Promise<AgentHarness[]> {
  const mark = (h: Exclude<AgentHarness, 'all' | 'skip'>) => (detected.includes(h) ? ' [detected]' : '');
  const singleDefaultMap: Record<Exclude<AgentHarness, 'all' | 'skip'>, string> = {
    antigravity: '1',
    claude: '2',
    codex: '3',
    opencode: '4',
    agents: '5',
  };
  const defaultChoice = detected.length === 1 ? singleDefaultMap[detected[0]!] : '6';

  console.log(`?  Select AI Agent Harness to configure for this project:`);
  console.log(`   [1] Google Antigravity (.gemini/mcp_config.json, .gemini/rules/, .gemini/skills/, .gemini/hooks/)${mark('antigravity')}`);
  console.log(`   [2] Claude Code        (.mcp.json, .claude/settings.json, CLAUDE.md, .claude/skills/, .claude/hooks/)${mark('claude')}`);
  console.log(`   [3] OpenAI Codex       (.codex/config.toml, AGENTS.md, .codex/skills/, .codex/hooks/)${mark('codex')}`);
  console.log(`   [4] OpenCode           (opencode.json, AGENTS.md, opencode/skills/, opencode/hooks/)${mark('opencode')}`);
  console.log(`   [5] .agents (General)  (.agents/mcp.json, AGENTS.md, .agents/skills/, .agents/hooks/)${mark('agents')}`);
  console.log(`   [6] All (Multi-Harness)`);
  console.log(`   [7] Skip MCP Config    (Guidance & SQLite index only)\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`Enter choice [1-7] (default: ${defaultChoice}): `);
    const choice = answer.trim() || defaultChoice;
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
  const profile = await detectProjectProfile(cwd);
  const framework = profile.label;

  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log(`\n${cyan}◆${reset}  ${bold}strata init v${STRATA_VERSION}${reset}`);
  console.log(`${cyan}│${reset}  ${profile.isUiProject ? 'Frontend Structural AST Intelligence & Local MCP Engine' : 'Structural AST Intelligence & Local MCP Engine (TS/JS)'}`);
  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}◇${reset}  Target Workspace: ${bold}${cwd}${reset}`);
  console.log(`${cyan}│${reset}  • Detected: ${green}${framework}${reset}`);

  // Determine harnesses to configure
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.BUN_TEST);
  const isCI = Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);
  const detectedHarnesses = detectExistingHarnesses(cwd);
  let selectedHarnesses: AgentHarness[];
  if (options.harness) {
    selectedHarnesses = parseHarnessArg(options.harness);
  } else if (options.yes || !process.stdin.isTTY || isTest || isCI) {
    selectedHarnesses = detectedHarnesses.length > 0 ? detectedHarnesses : ['all'];
  } else {
    selectedHarnesses = await promptHarnessChoice(detectedHarnesses);
  }

  console.log(`${cyan}│${reset}  • Harnesses: ${bold}${selectedHarnesses.join(', ')}${reset}${!options.harness && detectedHarnesses.length > 0 ? ` ${dim}(detected; pass --harness all to configure all clients)${reset}` : ''}`);
  console.log(`${cyan}◇${reset}  Creating local project structure & agent artifacts:`);

  // 1. Prepare directory structure for graph cache
  const strataDir = join(cwd, '.strata');
  await fs.mkdir(strataDir, { recursive: true });

  console.log(`${cyan}│${reset}  ${green}✔${reset} .strata/                   ${dim}(Isolated SQLite graph cache)${reset}`);

  // 2. Write agent harness rules, skills, and hooks (respecting selected harness, project type & --force)
  const artifactResults = await setupHarnessArtifacts(cwd, selectedHarnesses, force, {
    isUiProject: profile.isUiProject,
  });
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

  // 5. Rebuild the complete index on every init, including unchanged source files.
  console.log(`${cyan}│${reset}`);
  console.log(`${cyan}◇${reset}  ${profile.isUiProject ? 'Indexing frontend components:' : 'Indexing workspace source files:'}`);
  try {
    const { onProgress, stageDurationsMs } = createSyncProgressReporter();

    const stats = await syncWorkspaceV3(cwd, { force: true, onProgress });
    defaultWarmDbPool.close(cwd);
    const totalFiles = stats.added + stats.modified + stats.unchanged;
    StrataTelemetry.recordSync(cwd, {
      source: 'strata_init',
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
    console.log(`${cyan}│${reset}  ${green}✔${reset} Indexed ${totalFiles.toLocaleString()} files (${stats.symbolsIndexed.toLocaleString()} symbols, ${stats.edgesIndexed.toLocaleString()} edges, ${stats.packagesSynced} package(s)) into .strata/graph.db in ${durationLabel}`);
  } catch (err: unknown) {
    const { failurePhase, recoveryInstruction, rawMessage } = classifySyncError(err);

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
  console.log(`   You can now run your AI agent in this directory (e.g. ${cyan}antigravity${reset}, ${cyan}claude${reset}, ${cyan}codex${reset}, ${cyan}opencode${reset}).\n`);
}
