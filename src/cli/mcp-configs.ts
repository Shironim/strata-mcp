import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STRATA_FRONTEND_RULE,
  STRATA_INSPECT_SKILL,
  STRATA_POST_WRITE_HOOK,
  STRATA_OPENCODE_PLUGIN,
  STRATA_CLAUDE_COMMAND,
  STRATA_TS_RULE,
  STRATA_TS_SKILL,
  STRATA_TS_CLAUDE_COMMAND,
  STRATA_GEMINI_MD_POINTER,
  STRATA_RULE_REFERENCE_FROM_AGENTS,
  STRATA_RULE_REFERENCE_FROM_GEMINI,
} from './templates';

export type AgentHarness =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'agents'
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
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'malformed', error: `Unable to read file: ${message}`, raw: '' };
  }
  try {
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
      raw,
    };
  }
}

/**
 * Shared read-validate-merge-write helper for JSON config files.
 * Preserves malformed JSON files untouched and returns structured ConfigAction.
 */
async function updateJsonConfigFile(
  filePath: string,
  displayLabel: string,
  mutator: (existing: Record<string, any> | null) => Record<string, any> | null
): Promise<{ action: ConfigAction; error?: string }> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const result = await readJsonConfigFile<Record<string, any>>(filePath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '${displayLabel}': ${result.error}. Preserving existing file without modification.`);
    return { action: 'failed', error: result.error };
  }

  const existing = result.status === 'valid' ? result.data : null;
  const next = mutator(existing);
  if (next === null) {
    return { action: 'skipped' };
  }

  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { action: existing ? 'updated' : 'created' };
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
  return updateJsonConfigFile(filePath, filePath, (existing) => {
    const base = existing ? { ...existing } : {};
    const servers = (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) ? { ...base[key] } : {};
    if (servers.strata && !force) {
      return null;
    }
    servers.strata = { command: 'strata', args: ['serve'] };
    base[key] = servers;
    return base;
  });
}

/**
 * Writes or merges OpenCode local MCP config in opencode.json (`mcp.strata`).
 * Defensively skips writes if existing config is malformed to prevent data loss.
 * Preserves existing Strata configuration unless force is true (INIT-02).
 */
async function writeOpenCodeConfig(
  filePath: string,
  force: boolean = false
): Promise<{ action: ConfigAction; error?: string }> {
  return updateJsonConfigFile(filePath, filePath, (existing) => {
    const base: Record<string, any> = existing
      ? { ...existing }
      : { $schema: 'https://opencode.ai/config.json' };
    const mcp = (base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp)) ? { ...base.mcp } : {};
    const legacyServers = (mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)) ? mcp.servers : null;
    const strataExists = Boolean(mcp.strata || legacyServers?.strata);

    if (strataExists && !force && !legacyServers?.strata) {
      return null;
    }

    mcp.strata = {
      type: 'local',
      command: ['strata', 'serve'],
      enabled: true,
    };

    if (legacyServers?.strata) {
      const cleanedServers = { ...legacyServers };
      delete cleanedServers.strata;
      if (Object.keys(cleanedServers).length === 0) {
        delete mcp.servers;
      } else {
        mcp.servers = cleanedServers;
      }
    }

    base.mcp = mcp;
    return base;
  });
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

function isStrataManagedHookEntry(entry: unknown): boolean {
  return JSON.stringify(entry ?? '').includes('strata-post-write');
}

/**
 * Configures Claude Code PostToolUse lifecycle hook to auto-sync Strata graph.
 */
async function configureClaudeHooks(
  projectRoot: string,
  force: boolean = false
): Promise<HarnessConfigResult> {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const canonicalHook = {
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command:
          'sh -c \'ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)}"; case "$ROOT" in */.claude|*/.codex|*/.agents|*/.gemini|*/opencode) ROOT="$(dirname "$ROOT")" ;; esac; for d in .claude .agents; do if [ -x "$ROOT/$d/hooks/strata-post-write.sh" ]; then exec "$ROOT/$d/hooks/strata-post-write.sh" --claude "$@"; fi; done; exit 0\'',
        timeout: 10,
      },
    ],
  };

  const res = await updateJsonConfigFile(settingsPath, '.claude/settings.json', (existing) => {
    const settings = existing ? { ...existing } : {};
    const hooks = (typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks))
      ? { ...settings.hooks }
      : {};
    const postToolHooks = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];

    const managedEntries = postToolHooks.filter(isStrataManagedHookEntry);
    const needsUpdate =
      managedEntries.length !== 1 ||
      force ||
      JSON.stringify(managedEntries[0]) !== JSON.stringify(canonicalHook);

    if (!needsUpdate) return null;

    const preservedUserHooks = postToolHooks.filter((h: any) => !isStrataManagedHookEntry(h));
    preservedUserHooks.push(canonicalHook);
    hooks.PostToolUse = preservedUserHooks;
    settings.hooks = hooks;
    return settings;
  });

  return { harness: 'Claude Code', file: '.claude/settings.json', action: res.action, error: res.error };
}

/**
 * Removes legacy Strata managed hook from .gemini/hooks.json (Antigravity does not index workspace .gemini/).
 * Preserves any user-authored entries and leaves malformed JSON untouched.
 */
async function cleanupLegacyGeminiHooks(projectRoot: string): Promise<void> {
  const legacyPath = join(projectRoot, '.gemini', 'hooks.json');
  const result = await readJsonConfigFile<Record<string, any>>(legacyPath);
  if (result.status !== 'valid') return;
  if (!('strata-autosync' in result.data)) return;

  const updated = { ...result.data };
  delete updated['strata-autosync'];
  if (Object.keys(updated).length === 0) {
    await fs.rm(legacyPath, { force: true });
  } else {
    await fs.writeFile(legacyPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }
}

/**
 * Configures Google Antigravity / .agents PostToolUse lifecycle hook in .agents/hooks.json.
 * Auto-migrates legacy invalid `hooks: [{ event: "post_tool_use", ... }]` arrays and `.gemini/hooks.json` entries.
 */
async function configureAntigravityAgentsHooks(
  projectRoot: string,
  harnessLabel: string,
  force: boolean = false
): Promise<HarnessConfigResult> {
  const agentsDir = join(projectRoot, '.agents');
  if (!existsSync(agentsDir)) {
    await fs.mkdir(agentsDir, { recursive: true });
  }

  await cleanupLegacyGeminiHooks(projectRoot);

  const hooksPath = join(agentsDir, 'hooks.json');
  const result = await readJsonConfigFile<Record<string, any>>(hooksPath);
  if (result.status === 'malformed') {
    console.error(`  ✕ Error: Malformed JSON in '.agents/hooks.json': ${result.error}. Preserving existing file without modification.`);
    return { harness: harnessLabel, file: '.agents/hooks.json', action: 'failed', error: result.error };
  }

  const config = result.status === 'valid' ? { ...result.data } : {};
  let staleMigrated = false;

  if (Array.isArray(config.hooks)) {
    const filtered = config.hooks.filter((h: any) => !isStrataManagedHookEntry(h));
    if (filtered.length !== config.hooks.length) {
      staleMigrated = true;
      if (filtered.length === 0) {
        delete config.hooks;
      } else {
        config.hooks = filtered;
      }
    }
  }

  const canonicalNamespace = {
    enabled: true,
    PostToolUse: [
      {
        matcher: 'write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content',
        hooks: [
          {
            type: 'command',
            command: './hooks/strata-post-write.sh --antigravity',
            timeout: 10,
          },
        ],
      },
    ],
  };

  const existingNamespace = config['strata-autosync'];
  const needsUpdate =
    staleMigrated ||
    force ||
    !existingNamespace ||
    JSON.stringify(existingNamespace) !== JSON.stringify(canonicalNamespace);

  if (!needsUpdate) {
    return { harness: harnessLabel, file: '.agents/hooks.json', action: 'skipped' };
  }

  config['strata-autosync'] = canonicalNamespace;
  await fs.writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { harness: harnessLabel, file: '.agents/hooks.json', action: result.status === 'valid' ? 'updated' : 'created' };
}

/**
 * Configures Codex PostToolUse lifecycle hook in .codex/hooks.json.
 */
async function configureCodexHooks(
  projectRoot: string,
  force: boolean = false
): Promise<HarnessConfigResult> {
  const hooksPath = join(projectRoot, '.codex', 'hooks.json');
  const canonicalHook = {
    matcher: 'Write|Edit|MultiEdit|apply_patch|write_file|edit_file|replace_file_content|write_to_file',
    hooks: [
      {
        type: 'command',
        command:
          'sh -c \'ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"; case "$ROOT" in */.claude|*/.codex|*/.agents|*/.gemini|*/opencode) ROOT="$(dirname "$ROOT")" ;; esac; for d in .codex .agents; do if [ -x "$ROOT/$d/hooks/strata-post-write.sh" ]; then exec "$ROOT/$d/hooks/strata-post-write.sh" --codex "$@"; fi; done; exit 0\'',
        timeout: 10,
      },
    ],
  };

  const res = await updateJsonConfigFile(hooksPath, '.codex/hooks.json', (existing) => {
    const config = existing ? { ...existing } : {};
    const hooks = (typeof config.hooks === 'object' && config.hooks !== null && !Array.isArray(config.hooks))
      ? { ...config.hooks }
      : {};
    const postToolHooks = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];

    const managedEntries = postToolHooks.filter(isStrataManagedHookEntry);
    const needsUpdate =
      managedEntries.length !== 1 ||
      force ||
      JSON.stringify(managedEntries[0]) !== JSON.stringify(canonicalHook);

    if (!needsUpdate) return null;

    const preservedUserHooks = postToolHooks.filter((h: any) => !isStrataManagedHookEntry(h));
    preservedUserHooks.push(canonicalHook);
    hooks.PostToolUse = preservedUserHooks;
    config.hooks = hooks;
    return config;
  });

  return { harness: 'Codex', file: '.codex/hooks.json', action: res.action, error: res.error };
}

/**
 * Configures OpenCode v2 lifecycle plugin in .opencode/plugin/strata-autosync.ts.
 * Auto-migrates legacy opencode/hooks.json managed entries if present.
 */
async function configureOpenCodeHooks(
  projectRoot: string,
  force: boolean = false
): Promise<HarnessConfigResult> {
  const legacyHooksPath = join(projectRoot, 'opencode', 'hooks.json');
  const legacyResult = await readJsonConfigFile<Record<string, any>>(legacyHooksPath);
  if (legacyResult.status === 'valid' && Array.isArray(legacyResult.data.hooks)) {
    const filtered = legacyResult.data.hooks.filter((h: any) => !isStrataManagedHookEntry(h));
    if (filtered.length !== legacyResult.data.hooks.length) {
      const updated = { ...legacyResult.data };
      if (filtered.length === 0) {
        delete updated.hooks;
      } else {
        updated.hooks = filtered;
      }
      if (Object.keys(updated).length === 0) {
        await fs.rm(legacyHooksPath, { force: true });
      } else {
        await fs.writeFile(legacyHooksPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      }
    }
  }

  const legacyPluginAltPath = join(projectRoot, '.opencode', 'plugins', 'strata-autosync.ts');
  if (existsSync(legacyPluginAltPath)) {
    try {
      const legacyAlt = await fs.readFile(legacyPluginAltPath, 'utf8');
      if (legacyAlt.includes('strata-autosync') || legacyAlt.includes('strata sync')) {
        await fs.rm(legacyPluginAltPath, { force: true });
      }
    } catch {}
  }

  const pluginDir = join(projectRoot, '.opencode', 'plugin');
  if (!existsSync(pluginDir)) {
    await fs.mkdir(pluginDir, { recursive: true });
  }
  const pluginPath = join(pluginDir, 'strata-autosync.ts');
  const exists = existsSync(pluginPath);
  if (exists) {
    const existing = await fs.readFile(pluginPath, 'utf8');
    const isManagedV2 = existing.includes('// managed-marker: opencode-v2 strata-autosync');
    const isLegacyManagedV1 =
      (existing.includes('strata-autosync') || existing.includes('strata sync')) &&
      (existing.includes('tool.execute.before') || existing.includes('tool.execute.after') || existing.includes('@opencode-ai/plugin'));
    if (!isManagedV2 && !isLegacyManagedV1 && !force) {
      return { harness: 'OpenCode', file: '.opencode/plugin/strata-autosync.ts', action: 'skipped' };
    }
    if (existing === STRATA_OPENCODE_PLUGIN) {
      return { harness: 'OpenCode', file: '.opencode/plugin/strata-autosync.ts', action: 'skipped' };
    }
    await fs.writeFile(pluginPath, STRATA_OPENCODE_PLUGIN, 'utf8');
    return { harness: 'OpenCode', file: '.opencode/plugin/strata-autosync.ts', action: 'updated' };
  }

  await fs.writeFile(pluginPath, STRATA_OPENCODE_PLUGIN, 'utf8');
  return { harness: 'OpenCode', file: '.opencode/plugin/strata-autosync.ts', action: 'created' };
}

/**
 * Configures local project MCP settings for selected agent harnesses.
 * Exclusively supports: Antigravity (.agents), Claude Code (.claude), Codex (.codex),
 * Opencode (opencode/), and .agents (general).
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

  let agentsMcpHandledThisRun = false;
  let agentsHooksHandledThisRun = false;

  const ensureAgentsMcpAndHooks = async (harnessLabel: string) => {
    if (!agentsMcpHandledThisRun) {
      agentsMcpHandledThisRun = true;
      const file = join(projectRoot, '.agents', 'mcp.json');
      const res = await writeStandardMcpConfig(file, 'mcpServers', force);
      if (res.action === 'failed') {
        results.push({ harness: harnessLabel, file: '.agents/mcp.json', action: 'failed', error: res.error });
      } else {
        results.push({ harness: harnessLabel, file: '.agents/mcp.json', action: res.action });
      }
    }

    if (!agentsHooksHandledThisRun) {
      agentsHooksHandledThisRun = true;
      const hookRes = await configureAntigravityAgentsHooks(projectRoot, harnessLabel, force);
      results.push(hookRes);
    }
  };

  // 1. Google Antigravity (.agents/mcp.json & .agents/hooks.json; global MCP notice printed by init)
  if (shouldApply('antigravity')) {
    await ensureAgentsMcpAndHooks('Google Antigravity');
  }

  // 2. Claude Code (.mcp.json & .claude/settings.json)
  if (shouldApply('claude')) {
    const file = join(projectRoot, '.mcp.json');
    const res = await writeStandardMcpConfig(file, 'mcpServers', force);
    if (res.action === 'failed') {
      results.push({ harness: 'Claude Code', file: '.mcp.json', action: 'failed', error: res.error });
    } else {
      results.push({ harness: 'Claude Code', file: '.mcp.json', action: res.action });
    }

    const hookRes = await configureClaudeHooks(projectRoot, force);
    results.push(hookRes);
  }

  // 3. OpenAI Codex (.codex/config.toml & .codex/hooks.json)
  if (shouldApply('codex')) {
    const codexDir = join(projectRoot, '.codex');
    const tomlPath = join(codexDir, 'config.toml');
    const res = appendTomlMcpServer(tomlPath, 'strata', 'strata', ['serve'], force);
    if (res.action === 'failed') {
      results.push({ harness: 'Codex', file: '.codex/config.toml', action: 'failed', error: res.error });
    } else {
      results.push({ harness: 'Codex', file: '.codex/config.toml', action: res.action });
    }

    const hookRes = await configureCodexHooks(projectRoot, force);
    results.push(hookRes);
  }

  // 4. OpenCode (opencode.json & .opencode/plugin/strata-autosync.ts)
  if (shouldApply('opencode')) {
    const file = join(projectRoot, 'opencode.json');
    const res = await writeOpenCodeConfig(file, force);
    if (res.action === 'failed') {
      results.push({ harness: 'OpenCode', file: 'opencode.json', action: 'failed', error: res.error });
    } else {
      results.push({ harness: 'OpenCode', file: 'opencode.json', action: res.action });
    }

    const hookRes = await configureOpenCodeHooks(projectRoot, force);
    results.push(hookRes);
  }

  // 5. .agents (general) (.agents/mcp.json & .agents/hooks.json)
  if (shouldApply('agents')) {
    await ensureAgentsMcpAndHooks('.agents (general)');
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
 * Writes or auto-migrates a Strata-managed hook script (mode 0o755).
 * Preserves user-authored scripts that lack the Strata marker unless force is true.
 */
async function writeManagedHookScript(
  filePath: string,
  force: boolean = false
): Promise<ConfigAction> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    const existing = await fs.readFile(filePath, 'utf8');
    const isManaged =
      existing.includes('Strata-MCP Post-Write') ||
      existing.includes('managed-marker: strata-post-write');
    if (!isManaged && !force) {
      return 'skipped';
    }
    if (existing === STRATA_POST_WRITE_HOOK) {
      await fs.chmod(filePath, 0o755);
      return 'skipped';
    }
    await fs.writeFile(filePath, STRATA_POST_WRITE_HOOK, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(filePath, 0o755);
    return 'updated';
  }

  await fs.writeFile(filePath, STRATA_POST_WRITE_HOOK, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(filePath, 0o755);
  return 'created';
}

async function cleanupLegacyManagedFile(filePath: string, marker: string): Promise<void> {
  if (!existsSync(filePath)) return;
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    if (existing.includes(marker)) {
      await fs.rm(filePath, { force: true });
    }
  } catch {}
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

export interface SetupHarnessArtifactOptions {
  isUiProject?: boolean;
}

async function fileContainsStrataGuidance(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.includes('strata-mcp') || content.includes('Strata-MCP');
  } catch {
    return false;
  }
}

/**
 * Generates per-harness rules, skills, and lifecycle hook scripts.
 * Exclusively supports: Antigravity (.gemini), Claude Code (.claude), Codex (.codex),
 * Opencode (opencode/), and .agents (general).
 */
export async function setupHarnessArtifacts(
  projectRoot: string,
  harnesses: AgentHarness[],
  force: boolean = false,
  options: SetupHarnessArtifactOptions = {}
): Promise<HarnessConfigResult[]> {
  const results: HarnessConfigResult[] = [];
  const selectedSet = new Set(harnesses.map(h => h.toLowerCase()));
  const shouldApply = (h: AgentHarness) => selectedSet.has('all') || selectedSet.has(h);

  const isUiProject = options.isUiProject ?? true;
  const ruleTemplate = isUiProject ? STRATA_FRONTEND_RULE : STRATA_TS_RULE;
  const skillTemplate = isUiProject ? STRATA_INSPECT_SKILL : STRATA_TS_SKILL;
  const claudeCommandTemplate = isUiProject ? STRATA_CLAUDE_COMMAND : STRATA_TS_CLAUDE_COMMAND;

  const agentsDocPath = join(projectRoot, 'AGENTS.md');
  const geminiDocPath = join(projectRoot, 'GEMINI.md');
  const sharedSkillPath = join(projectRoot, '.agents', 'skills', 'use-strata', 'SKILL.md');

  const agentsHarnessRequested =
    shouldApply('codex') || shouldApply('opencode') || shouldApply('agents') || selectedSet.has('skip');
  const agentsAlreadyHasStrata = await fileContainsStrataGuidance(agentsDocPath);
  const agentsWillHoldRule = agentsHarnessRequested || agentsAlreadyHasStrata;
  const geminiAlreadyHasStrata = await fileContainsStrataGuidance(geminiDocPath);

  const record = (harness: string, file: string, action: ConfigAction) => {
    results.push({ harness, file, action });
  };

  // Helper to cleanly clean up legacy skill directory
  const cleanupLegacy = async (dirPath: string) => {
    if (existsSync(dirPath)) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
      } catch {}
    }
  };

  let sharedAgentsHookHandledThisRun = false;
  const ensureAgentsHookScript = async (harnessLabel: string) => {
    if (sharedAgentsHookHandledThisRun) return;
    sharedAgentsHookHandledThisRun = true;
    const hAction = await writeManagedHookScript(join(projectRoot, '.agents', 'hooks', 'strata-post-write.sh'), force);
    record(harnessLabel, '.agents/hooks/strata-post-write.sh', hAction);
  };

  let sharedAgentsSkillHandledThisRun = false;
  const ensureAgentsSkill = async (harnessLabel: string) => {
    if (sharedAgentsSkillHandledThisRun) return;
    sharedAgentsSkillHandledThisRun = true;
    await cleanupLegacy(join(projectRoot, '.agents', 'skills', 'strata-inspect'));
    const sAction = await writeDedicatedArtifact(sharedSkillPath, skillTemplate, force);
    record(harnessLabel, '.agents/skills/use-strata/SKILL.md', sAction);
  };

  // 1. Google Antigravity (.agents/rules/, .agents/skills/, .agents/hooks/ — no .gemini/ directory)
  if (shouldApply('antigravity')) {
    const agentsRuleContent = agentsWillHoldRule
      ? STRATA_RULE_REFERENCE_FROM_AGENTS
      : geminiAlreadyHasStrata
        ? STRATA_RULE_REFERENCE_FROM_GEMINI
        : ruleTemplate;

    const rAction = await writeDedicatedArtifact(join(projectRoot, '.agents', 'rules', 'strata-frontend.md'), agentsRuleContent, force);
    record('Google Antigravity', '.agents/rules/strata-frontend.md', rAction);

    // Avoid duplicating rules into GEMINI.md when AGENTS.md + .agents/rules/ already cover workspace guidance;
    // when Antigravity is configured standalone, write a compact pointer in GEMINI.md instead of copying all rule lines.
    if (!agentsHarnessRequested) {
      const gmAction = await writeMarkdownGuidance(geminiDocPath, STRATA_GEMINI_MD_POINTER, force);
      record('Google Antigravity', 'GEMINI.md', gmAction);
    }

    // Clean up legacy .gemini/ strata-managed files (Antigravity does not index workspace .gemini/)
    await cleanupLegacy(join(projectRoot, '.gemini', 'skills', 'strata-inspect'));
    await cleanupLegacy(join(projectRoot, '.gemini', 'skills', 'use-strata'));
    await cleanupLegacyManagedFile(join(projectRoot, '.gemini', 'rules', 'strata-frontend.md'), 'Strata-MCP');
    await cleanupLegacyManagedFile(join(projectRoot, '.gemini', 'hooks', 'strata-post-write.sh'), 'Strata-MCP Post-Write');

    await ensureAgentsSkill('Google Antigravity');
    await ensureAgentsHookScript('Google Antigravity');
  }

  // 2. Claude Code (.claude/)
  if (shouldApply('claude')) {
    const rAction = await writeMarkdownGuidance(join(projectRoot, 'CLAUDE.md'), ruleTemplate, force);
    record('Claude Code', 'CLAUDE.md', rAction);

    await cleanupLegacy(join(projectRoot, '.claude', 'skills', 'strata-inspect'));
    const skillAction = await writeDedicatedArtifact(join(projectRoot, '.claude', 'skills', 'use-strata', 'SKILL.md'), skillTemplate, force);
    record('Claude Code', '.claude/skills/use-strata/SKILL.md', skillAction);

    await cleanupLegacy(join(projectRoot, '.claude', 'commands', 'strata-inspect.md'));
    const cAction = await writeDedicatedArtifact(join(projectRoot, '.claude', 'commands', 'use-strata.md'), claudeCommandTemplate, force);
    record('Claude Code', '.claude/commands/use-strata.md', cAction);

    const hAction = await writeManagedHookScript(join(projectRoot, '.claude', 'hooks', 'strata-post-write.sh'), force);
    record('Claude Code', '.claude/hooks/strata-post-write.sh', hAction);
  }

  // 3-5. Shared AGENTS.md writer (executed once per init pass across Codex, OpenCode, .agents, and skip)
  let agentsDocHandledThisRun = false;
  const ensureAgentsGuidance = async (harnessLabel: string) => {
    if (agentsDocHandledThisRun) return;
    agentsDocHandledThisRun = true;
    const agAction = await writeMarkdownGuidance(agentsDocPath, ruleTemplate, force);
    record(harnessLabel, 'AGENTS.md', agAction);
  };

  // 3. OpenAI Codex (.codex/)
  if (shouldApply('codex')) {
    await ensureAgentsGuidance('Codex');

    await cleanupLegacy(join(projectRoot, '.codex', 'skills', 'strata-inspect'));
    const sAction = await writeDedicatedArtifact(join(projectRoot, '.codex', 'skills', 'use-strata', 'SKILL.md'), skillTemplate, force);
    record('Codex', '.codex/skills/use-strata/SKILL.md', sAction);

    const hAction = await writeManagedHookScript(join(projectRoot, '.codex', 'hooks', 'strata-post-write.sh'), force);
    record('Codex', '.codex/hooks/strata-post-write.sh', hAction);
  }

  // 4. OpenCode (opencode/ skills & .opencode/plugin/)
  if (shouldApply('opencode')) {
    await ensureAgentsGuidance('OpenCode');

    await cleanupLegacy(join(projectRoot, 'opencode', 'skills', 'strata-inspect'));
    const sAction = await writeDedicatedArtifact(join(projectRoot, 'opencode', 'skills', 'use-strata', 'SKILL.md'), skillTemplate, force);
    record('OpenCode', 'opencode/skills/use-strata/SKILL.md', sAction);

    await cleanupLegacyManagedFile(join(projectRoot, 'opencode', 'hooks', 'strata-post-write.sh'), 'Strata-MCP Post-Write');
  }

  // 5. .agents (general)
  if (shouldApply('agents')) {
    await ensureAgentsGuidance('.agents (general)');
    await ensureAgentsSkill('.agents (general)');
    await ensureAgentsHookScript('.agents (general)');
  }

  // Fallback if skipping MCP config
  if (selectedSet.has('skip')) {
    await ensureAgentsGuidance('Fallback Guidance');
    await ensureAgentsSkill('Fallback Skills');
    await ensureAgentsHookScript('Fallback Hooks');
  }

  return results;
}
