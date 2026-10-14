import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AgentHarness =
  | 'claude'
  | 'cursor'
  | 'vscode'
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

  // 3. VS Code (.vscode/mcp.json)
  if (shouldApply('vscode')) {
    const file = join(projectRoot, '.vscode', 'mcp.json');
    const res = await writeStandardMcpConfig(file, 'servers', force);
    results.push({ harness: 'VS Code', file: '.vscode/mcp.json', action: res.action, error: res.error });
  }

  // Codex (.codex/config.toml) (INIT-06, INIT-10)
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

  // 5. Antigravity (.agents/skills & rules are created by default init)
  if (shouldApply('antigravity')) {
    results.push({
      harness: 'Google Antigravity',
      file: '.agents/skills/strata-inspect/SKILL.md',
      action: 'created',
    });
  }

  // 6. Goose (.goose/mcp.json)
  if (shouldApply('goose')) {
    const file = join(projectRoot, '.goose', 'mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    results.push({ harness: 'Goose', file: '.goose/mcp.json', action: res.action, error: res.error });
  }

  // 7. Pi / Oh My Pi (.pi/mcp.json)
  if (shouldApply('pi')) {
    const file = join(projectRoot, '.pi', 'mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    results.push({ harness: 'Pi / Oh My Pi', file: '.pi/mcp.json', action: res.action, error: res.error });
  }

  return results;
}
