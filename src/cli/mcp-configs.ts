import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STRATA_FRONTEND_RULE,
  STRATA_INSPECT_SKILL,
  STRATA_POST_WRITE_HOOK,
  STRATA_CURSOR_RULE,
  STRATA_CLAUDE_COMMAND,
  STRATA_GOOSEHINTS,
} from './templates';

export type AgentHarness =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'opencode'
  | 'antigravity'
  | 'goose'
  | 'pi'
  | 'all'
  | 'skip';

export type ConfigAction = 'created' | 'updated' | 'skipped' | 'failed';

export interface HarnessConfigResult {
  harness: string;
  file: string;
  action: ConfigAction;
  error?: string;
}

export type ConfigReadResult<T = Record<string, any>> =
  | { status: 'missing' }
  | { status: 'valid'; data: T }
  | { status: 'malformed'; error: string; raw: string };

/**
 * Safely reads and parses a JSON config file with explicit status modeling.
 * Prevents accidental overwrite of malformed or corrupt user files.
 */
export async function readJsonConfigFile<T = Record<string, any>>(filePath: string): Promise<ConfigReadResult<T>> {
  if (!existsSync(filePath)) return { status: 'missing' };
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        status: 'malformed',
        error: `Expected JSON object root, found ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
        raw,
      };
    }
    return { status: 'valid', data: parsed as T };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'malformed',
      error: `Malformed JSON syntax: ${message}`,
      raw: '',
    };
  }
}

/**
 * Backwards-compatible safe JSON reader that returns null on error.
 */
export async function readJsonSafe<T = Record<string, any>>(filePath: string): Promise<T | null> {
  const result = await readJsonConfigFile<T>(filePath);
  return result.status === 'valid' ? result.data : null;
}

/**
 * Writes or merges standard MCP server config (mcpServers: { strata: { command, args } }).
 * Defensively skips writes if existing config is malformed to prevent data loss.
 * Preserves existing Strata configuration unless force is true (INIT-02).
 */
async function writeStandardMcpConfig(
  filePath: string,
  key: 'mcpServers' | 'servers' = 'mcpServers',
  force: boolean = false
): Promise<{ action: ConfigAction; error?: string }> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const result = await readJsonConfigFile<Record<string, any>>(filePath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '${filePath}': ${result.error}. Preserving existing file without modification.`);
    return { action: 'failed', error: result.error };
  }

  const existing = result.status === 'valid' ? result.data : null;
  const base = existing || {};
  const servers = (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) ? base[key] : {};

  const strataExists = Boolean(servers.strata);

  if (strataExists && !force) {
    return { action: 'skipped' };
  }

  servers.strata = {
    command: 'strata',
    args: ['serve'],
  };

  base[key] = servers;

  await fs.writeFile(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return { action: existing ? 'updated' : 'created' };
}

/**
 * Writes or merges OpenCode local MCP config in opencode.json.
 * Defensively skips writes if existing config is malformed to prevent data loss.
 * Preserves existing Strata configuration unless force is true (INIT-02).
 */
async function writeOpenCodeConfig(
  filePath: string,
  force: boolean = false
): Promise<{ action: ConfigAction; error?: string }> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const result = await readJsonConfigFile<Record<string, any>>(filePath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '${filePath}': ${result.error}. Preserving existing file without modification.`);
    return { action: 'failed', error: result.error };
  }

  const existing = result.status === 'valid' ? result.data : null;
  const base = existing || {
    $schema: 'https://opencode.ai/config.json',
  };

  const mcp = (base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp)) ? base.mcp : {};
  const strataExists = Boolean(mcp.strata);

  if (strataExists && !force) {
    return { action: 'skipped' };
  }

  mcp.strata = {
    type: 'local',
    command: ['strata', 'serve'],
  };

  base.mcp = mcp;

  await fs.writeFile(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return { action: existing ? 'updated' : 'created' };
}

/**
 * Safely parses TOML syntax to validate structure and detect duplicate tables.
 */
export function parseTomlSafe(content: string): { valid: boolean; data?: any; error?: string } {
  try {
    if (typeof (globalThis as any).Bun?.TOML?.parse === 'function') {
      const data = (globalThis as any).Bun.TOML.parse(content);
      return { valid: true, data };
    }
    return { valid: true };
  } catch (err: unknown) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Appends or updates an MCP server entry in TOML format (used by OpenAI Codex CLI).
 * Handles bare and quoted keys ([mcp_servers."strata"], [mcp_servers.'strata'], etc.) (INIT-03).
 * Respects force flag and returns accurate operation status (INIT-06).
 */
export function appendTomlMcpServer(
  tomlPath: string,
  serverName: string,
  command: string,
  args: string[],
  force: boolean = false
): { action: ConfigAction; error?: string } {
  let existingContent = '';
  const exists = existsSync(tomlPath);
  if (exists) {
    existingContent = readFileSync(tomlPath, 'utf8');
    const parsed = parseTomlSafe(existingContent);
    if (!parsed.valid) {
      console.error(`  ✕ Error: Malformed TOML in '${tomlPath}': ${parsed.error}. Preserving existing file without modification.`);
      return { action: 'failed', error: parsed.error };
    }
  }

  const tableHeader = `[mcp_servers.${serverName}]`;
  const formattedArgs = JSON.stringify(args);
  const block = `\n${tableHeader}\ncommand = "${command}"\nargs = ${formattedArgs}\n`;

  // Matches any valid TOML table header equivalent to [mcp_servers.<serverName>]
  // e.g. [mcp_servers.strata], [mcp_servers."strata"], [ "mcp_servers" . 'strata' ]
  const activeTableHeaderRegex = new RegExp(
    `^[ \\t]*\\[[ \\t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \\t]*\\.[ \\t]*(?:${serverName}|"${serverName}"|'${serverName}')[ \\t]*\\][ \\t]*(?:#.*)?$`,
    'm'
  );
  const hasActiveTable = activeTableHeaderRegex.test(existingContent);

  if (hasActiveTable) {
    if (force) {
      const lines = existingContent.split('\n');
      const startIdx = lines.findIndex(l => activeTableHeaderRegex.test(l));
      if (startIdx !== -1) {
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            endIdx = i;
            break;
          }
        }
        const replacementLines = [
          tableHeader,
          `command = "${command}"`,
          `args = ${formattedArgs}`,
        ];
        lines.splice(startIdx, endIdx - startIdx, ...replacementLines);
        const updated = lines.join('\n');
        const parsed = parseTomlSafe(updated);
        if (!parsed.valid) {
          console.error(`  ✕ Error: Updating TOML in '${tomlPath}' would produce invalid TOML: ${parsed.error}. Preserving existing file.`);
          return { action: 'failed', error: parsed.error };
        }
        writeFileSync(tomlPath, updated, 'utf8');
        return { action: 'updated' };
      }
    }
    return { action: 'skipped' };
  }

  const newContent = (existingContent.trim() ? existingContent.trim() + '\n' : '') + block;
  const parsed = parseTomlSafe(newContent);
  if (!parsed.valid) {
    console.error(`  ✕ Error: Appending to TOML in '${tomlPath}' would produce invalid TOML: ${parsed.error}. Preserving existing file.`);
    return { action: 'failed', error: parsed.error };
  }

  const dir = dirname(tomlPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(tomlPath, newContent, 'utf8');
  return { action: exists ? 'updated' : 'created' };
}

/**
 * Configures Claude Code PostToolUse lifecycle hook to auto-sync Strata graph.
 */
async function configureClaudeHooks(projectRoot: string): Promise<HarnessConfigResult | null> {
  const claudeDir = join(projectRoot, '.claude');
  if (!existsSync(claudeDir)) {
    await fs.mkdir(claudeDir, { recursive: true });
  }
  const settingsPath = join(claudeDir, 'settings.json');
  const result = await readJsonConfigFile<Record<string, any>>(settingsPath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '.claude/settings.json': ${result.error}. Preserving existing file without modification.`);
    return { harness: 'Claude Code', file: '.claude/settings.json', action: 'failed', error: result.error };
  }

  const settings = result.status === 'valid' ? result.data : {};
  const hooks = (typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks))
    ? settings.hooks
    : {};
  const postToolHooks = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];

  const hasStrataHook = postToolHooks.some((h: any) =>
    JSON.stringify(h).includes('strata-post-write')
  );

  const canonicalHook = {
    matcher: 'Write|Edit|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command:
          "sh -c 'ROOT=\".\"; if [ ! -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; fi; if [ -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then exec \"$ROOT/.agents/hooks/strata-post-write.sh\" \"$CLAUDE_FILE_PATH\"; fi'",
      },
    ],
  };

  if (!hasStrataHook) {
    postToolHooks.push(canonicalHook);
    hooks.PostToolUse = postToolHooks;
    settings.hooks = hooks;
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return { harness: 'Claude Code', file: '.claude/settings.json', action: result.status === 'valid' ? 'updated' : 'created' };
  }

  return { harness: 'Claude Code', file: '.claude/settings.json', action: 'skipped' };
}

/**
 * Configures Cursor IDE postToolUse lifecycle hook to auto-sync Strata graph.
 */
async function configureCursorHooks(projectRoot: string): Promise<HarnessConfigResult | null> {
  const cursorDir = join(projectRoot, '.cursor');
  if (!existsSync(cursorDir)) {
    await fs.mkdir(cursorDir, { recursive: true });
  }
  const hooksPath = join(cursorDir, 'hooks.json');
  const result = await readJsonConfigFile<Record<string, any>>(hooksPath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '.cursor/hooks.json': ${result.error}. Preserving existing file without modification.`);
    return { harness: 'Cursor', file: '.cursor/hooks.json', action: 'failed', error: result.error };
  }

  const config = result.status === 'valid' ? result.data : { version: 1, hooks: {} };
  config.version = config.version || 1;
  config.hooks = (typeof config.hooks === 'object' && config.hooks !== null && !Array.isArray(config.hooks))
    ? config.hooks
    : {};
  const postToolUse = Array.isArray(config.hooks.postToolUse) ? config.hooks.postToolUse : [];

  const hasStrataHook = postToolUse.some((h: any) =>
    JSON.stringify(h).includes('strata-post-write')
  );

  const canonicalHook = {
    matcher: 'Write|Edit',
    command:
      "sh -c 'ROOT=\".\"; if [ ! -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; fi; if [ -f \"$ROOT/.agents/hooks/strata-post-write.sh\" ]; then exec \"$ROOT/.agents/hooks/strata-post-write.sh\"; fi'",
  };

  if (!hasStrataHook) {
    postToolUse.push(canonicalHook);
    config.hooks.postToolUse = postToolUse;
    await fs.writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { harness: 'Cursor', file: '.cursor/hooks.json', action: result.status === 'valid' ? 'updated' : 'created' };
  }

  return { harness: 'Cursor', file: '.cursor/hooks.json', action: 'skipped' };
}

/**
 * Configures Google Antigravity PostToolUse lifecycle hook to auto-sync Strata graph in .gemini/hooks.json.
 */
async function configureGeminiHooks(projectRoot: string): Promise<HarnessConfigResult | null> {
  const geminiDir = join(projectRoot, '.gemini');
  if (!existsSync(geminiDir)) {
    await fs.mkdir(geminiDir, { recursive: true });
  }
  const hooksPath = join(geminiDir, 'hooks.json');
  const result = await readJsonConfigFile<Record<string, any>>(hooksPath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '.gemini/hooks.json': ${result.error}. Preserving existing file without modification.`);
    return { harness: 'Google Antigravity', file: '.gemini/hooks.json', action: 'failed', error: result.error };
  }

  const config = result.status === 'valid' ? result.data : {};
  if (config['strata-autosync']) {
    return { harness: 'Google Antigravity', file: '.gemini/hooks.json', action: 'skipped' };
  }

  config['strata-autosync'] = {
    PostToolUse: [
      {
        matcher: 'replace_file_content|write_to_file',
        hooks: [
          {
            type: 'command',
            command: 'strata sync --json',
          },
        ],
      },
    ],
  };

  await fs.writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { harness: 'Google Antigravity', file: '.gemini/hooks.json', action: result.status === 'valid' ? 'updated' : 'created' };
}

/**
 * Configures local project MCP settings for selected agent harnesses.
 */
export async function setupHarnessConfigs(
  projectRoot: string,
  harnesses: AgentHarness[],
  force: boolean = false
): Promise<HarnessConfigResult[]> {
  const results: HarnessConfigResult[] = [];
  const selectedSet = new Set(harnesses.map(h => h.toLowerCase()));

  const shouldApply = (h: AgentHarness) => selectedSet.has('all') || selectedSet.has(h);

  if (selectedSet.has('skip')) {
    return results;
  }

  // 1. Claude Code (.mcp.json & .claude/settings.json)
  if (shouldApply('claude')) {
    const file = join(projectRoot, '.mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    const hookRes = await configureClaudeHooks(projectRoot);
    if (res.action === 'failed') {
      results.push({ harness: 'Claude Code', file: '.mcp.json', action: 'failed', error: res.error });
    } else if (hookRes && hookRes.action === 'failed') {
      results.push({ harness: 'Claude Code', file: '.claude/settings.json', action: 'failed', error: hookRes.error });
    } else {
      results.push({ harness: 'Claude Code', file: '.mcp.json', action: res.action });
    }
  }

  // 2. Cursor (.cursor/mcp.json & .cursor/hooks.json)
  if (shouldApply('cursor')) {
    const file = join(projectRoot, '.cursor', 'mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    const hookRes = await configureCursorHooks(projectRoot);
    if (res.action === 'failed') {
      results.push({ harness: 'Cursor', file: '.cursor/mcp.json', action: 'failed', error: res.error });
    } else if (hookRes && hookRes.action === 'failed') {
      results.push({ harness: 'Cursor', file: '.cursor/hooks.json', action: 'failed', error: hookRes.error });
    } else {
      results.push({ harness: 'Cursor', file: '.cursor/mcp.json', action: res.action });
    }
  }

  // 3. Codex (.codex/config.toml) (INIT-06, INIT-10)
  if (shouldApply('codex')) {
    const codexDir = join(projectRoot, '.codex');
    const tomlPath = join(codexDir, 'config.toml');
    const res = appendTomlMcpServer(tomlPath, 'strata', 'strata', ['serve'], force);
    results.push({ harness: 'Codex', file: '.codex/config.toml', action: res.action, error: res.error });
  }

  // 4. OpenCode (opencode.json)
  if (shouldApply('opencode')) {
    const file = join(projectRoot, 'opencode.json');
    const res = await writeOpenCodeConfig(file, force);
    results.push({ harness: 'OpenCode', file: 'opencode.json', action: res.action, error: res.error });
  }

  // 5. Google Antigravity (.gemini/mcp_config.json & .gemini/hooks.json)
  if (shouldApply('antigravity')) {
    const geminiDir = join(projectRoot, '.gemini');
    if (!existsSync(geminiDir)) {
      await fs.mkdir(geminiDir, { recursive: true });
    }
    const file = join(geminiDir, 'mcp_config.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    const hookRes = await configureGeminiHooks(projectRoot);
    if (res.action === 'failed') {
      results.push({ harness: 'Google Antigravity', file: '.gemini/mcp_config.json', action: 'failed', error: res.error });
    } else if (hookRes && hookRes.action === 'failed') {
      results.push({ harness: 'Google Antigravity', file: '.gemini/hooks.json', action: 'failed', error: hookRes.error });
    } else {
      results.push({ harness: 'Google Antigravity', file: '.gemini/mcp_config.json', action: res.action });
    }
  }

  // 6. Goose (.goose/mcp.json)
  if (shouldApply('goose')) {
    const file = join(projectRoot, '.goose', 'mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    results.push({ harness: 'Goose', file: '.goose/mcp.json', action: res.action, error: res.error });
  }

  // 7. Pi / Oh My Pi (.pi/mcp.json & .omp/mcp.json)
  if (shouldApply('pi')) {
    const piFile = join(projectRoot, '.pi', 'mcp.json');
    const piRes = await writeStandardMcpConfig(piFile, 'mcpServers', force);
    results.push({ harness: 'Pi', file: '.pi/mcp.json', action: piRes.action, error: piRes.error });

    const ompFile = join(projectRoot, '.omp', 'mcp.json');
    const ompRes = await writeStandardMcpConfig(ompFile, 'mcpServers', force);
    results.push({ harness: 'Oh My Pi', file: '.omp/mcp.json', action: ompRes.action, error: ompRes.error });
  }

  return results;
}

/**
 * Safely writes or non-destructively appends markdown guidance without duplicating content.
 */
async function writeMarkdownGuidance(
  filePath: string,
  content: string,
  force: boolean = false
): Promise<ConfigAction> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    const existing = await fs.readFile(filePath, 'utf8');
    if (existing.includes('strata-mcp') || existing.includes('Strata-MCP')) {
      return 'skipped';
    }
    const updated = existing.trimEnd() + '\n\n' + content;
    await fs.writeFile(filePath, updated, 'utf8');
    return 'updated';
  }

  await fs.writeFile(filePath, content, 'utf8');
  return 'created';
}

/**
 * Writes a dedicated artifact file (overwrites only if force is true).
 */
async function writeDedicatedArtifact(
  filePath: string,
  content: string,
  force: boolean = false,
  mode?: number
): Promise<ConfigAction> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  if (existsSync(filePath) && !force) {
    return 'skipped';
  }

  const isExisting = existsSync(filePath);
  await fs.writeFile(filePath, content, mode ? { encoding: 'utf8', mode } : 'utf8');
  if (mode) {
    await fs.chmod(filePath, mode);
  }
  return isExisting ? 'updated' : 'created';
}

/**
 * Generates per-harness rules, skills, and lifecycle hook scripts.
 */
export async function setupHarnessArtifacts(
  projectRoot: string,
  harnesses: AgentHarness[],
  force: boolean = false
): Promise<HarnessConfigResult[]> {
  const results: HarnessConfigResult[] = [];
  const selectedSet = new Set(harnesses.map(h => h.toLowerCase()));
  const shouldApply = (h: AgentHarness) => selectedSet.has('all') || selectedSet.has(h);

  const record = (harness: string, file: string, action: ConfigAction) => {
    results.push({ harness, file, action });
  };

  // 1. Claude Code
  if (shouldApply('claude')) {
    const rAction = await writeMarkdownGuidance(join(projectRoot, 'CLAUDE.md'), STRATA_FRONTEND_RULE, force);
    record('Claude Code', 'CLAUDE.md', rAction);

    const cAction = await writeDedicatedArtifact(join(projectRoot, '.claude', 'commands', 'strata-inspect.md'), STRATA_CLAUDE_COMMAND, force);
    record('Claude Code', '.claude/commands/strata-inspect.md', cAction);

    const hAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'hooks', 'strata-post-write.sh'), STRATA_POST_WRITE_HOOK, force, 0o755);
    record('Claude Code', '.agents/hooks/strata-post-write.sh', hAction);
  }

  // 2. Cursor
  if (shouldApply('cursor')) {
    const rAction = await writeDedicatedArtifact(join(projectRoot, '.cursor', 'rules', 'strata-frontend.mdc'), STRATA_CURSOR_RULE, force);
    record('Cursor', '.cursor/rules/strata-frontend.mdc', rAction);

    const hAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'hooks', 'strata-post-write.sh'), STRATA_POST_WRITE_HOOK, force, 0o755);
    record('Cursor', '.agents/hooks/strata-post-write.sh', hAction);
  }

  // 3. Codex
  if (shouldApply('codex')) {
    const rAction = await writeMarkdownGuidance(join(projectRoot, 'AGENTS.md'), STRATA_FRONTEND_RULE, force);
    record('Codex', 'AGENTS.md', rAction);
  }

  // 5. OpenCode
  if (shouldApply('opencode')) {
    const agAction = await writeMarkdownGuidance(join(projectRoot, 'AGENTS.md'), STRATA_FRONTEND_RULE, force);
    record('OpenCode', 'AGENTS.md', agAction);

    const rAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'rules', 'strata-frontend.md'), STRATA_FRONTEND_RULE, force);
    record('OpenCode', '.agents/rules/strata-frontend.md', rAction);

    const sAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'skills', 'strata-inspect', 'SKILL.md'), STRATA_INSPECT_SKILL, force);
    record('OpenCode', '.agents/skills/strata-inspect/SKILL.md', sAction);

    const hAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'hooks', 'strata-post-write.sh'), STRATA_POST_WRITE_HOOK, force, 0o755);
    record('OpenCode', '.agents/hooks/strata-post-write.sh', hAction);
  }

  // 6. Google Antigravity (.gemini/)
  if (shouldApply('antigravity')) {
    const gmAction = await writeMarkdownGuidance(join(projectRoot, 'GEMINI.md'), STRATA_FRONTEND_RULE, force);
    record('Google Antigravity', 'GEMINI.md', gmAction);

    const rAction = await writeDedicatedArtifact(join(projectRoot, '.gemini', 'rules', 'strata-frontend.md'), STRATA_FRONTEND_RULE, force);
    record('Google Antigravity', '.gemini/rules/strata-frontend.md', rAction);

    const sAction = await writeDedicatedArtifact(join(projectRoot, '.gemini', 'skills', 'strata-inspect', 'SKILL.md'), STRATA_INSPECT_SKILL, force);
    record('Google Antigravity', '.gemini/skills/strata-inspect/SKILL.md', sAction);

    const hAction = await writeDedicatedArtifact(join(projectRoot, '.gemini', 'hooks', 'strata-post-write.sh'), STRATA_POST_WRITE_HOOK, force, 0o755);
    record('Google Antigravity', '.gemini/hooks/strata-post-write.sh', hAction);
  }

  // 7. Goose
  if (shouldApply('goose')) {
    const rAction = await writeMarkdownGuidance(join(projectRoot, '.goosehints'), STRATA_GOOSEHINTS, force);
    record('Goose', '.goosehints', rAction);
  }

  // 8. Pi / Oh My Pi
  if (shouldApply('pi')) {
    const rAction = await writeMarkdownGuidance(join(projectRoot, 'AGENTS.md'), STRATA_FRONTEND_RULE, force);
    record('Pi / Oh My Pi', 'AGENTS.md', rAction);

    const piSkillAction = await writeDedicatedArtifact(join(projectRoot, '.pi', 'skills', 'strata-inspect', 'SKILL.md'), STRATA_INSPECT_SKILL, force);
    record('Pi', '.pi/skills/strata-inspect/SKILL.md', piSkillAction);

    const ompSkillAction = await writeDedicatedArtifact(join(projectRoot, '.omp', 'skills', 'strata-inspect', 'SKILL.md'), STRATA_INSPECT_SKILL, force);
    record('Oh My Pi', '.omp/skills/strata-inspect/SKILL.md', ompSkillAction);
  }

  // 9. Skip / Fallback
  if (selectedSet.has('skip')) {
    const rAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'rules', 'strata-frontend.md'), STRATA_FRONTEND_RULE, force);
    record('Fallback Rules', '.agents/rules/strata-frontend.md', rAction);

    const sAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'skills', 'strata-inspect', 'SKILL.md'), STRATA_INSPECT_SKILL, force);
    record('Fallback Rules', '.agents/skills/strata-inspect/SKILL.md', sAction);

    const hAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'hooks', 'strata-post-write.sh'), STRATA_POST_WRITE_HOOK, force, 0o755);
    record('Fallback Rules', '.agents/hooks/strata-post-write.sh', hAction);
  }

  return results;
}
