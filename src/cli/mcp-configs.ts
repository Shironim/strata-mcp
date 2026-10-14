import { existsSync, promises as fs } from 'node:fs';
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

export interface HarnessConfigResult {
  harness: string;
  file: string;
  action: 'created' | 'updated' | 'skipped';
}

/**
 * Safely reads and parses an existing JSON file, returning null if invalid or missing.
 */
async function readJsonSafe<T = Record<string, any>>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Writes or merges standard MCP server config (mcpServers: { strata: { command, args } }).
 */
async function writeStandardMcpConfig(
  filePath: string,
  key: 'mcpServers' | 'servers' = 'mcpServers'
): Promise<'created' | 'updated'> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const existing = await readJsonSafe<Record<string, any>>(filePath);
  const action = existing ? 'updated' : 'created';

  const base = existing || {};
  const servers = (base[key] && typeof base[key] === 'object') ? base[key] : {};

  servers.strata = {
    command: 'strata',
    args: ['serve'],
  };

  base[key] = servers;

  await fs.writeFile(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return action;
}

/**
 * Writes or merges OpenCode local MCP config in opencode.json.
 */
async function writeOpenCodeConfig(filePath: string): Promise<'created' | 'updated'> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const existing = await readJsonSafe<Record<string, any>>(filePath);
  const action = existing ? 'updated' : 'created';

  const base = existing || {
    $schema: 'https://opencode.ai/config.json',
  };

  const mcp = (base.mcp && typeof base.mcp === 'object') ? base.mcp : {};

  mcp.strata = {
    type: 'local',
    command: ['strata', 'serve'],
  };

  base.mcp = mcp;

  await fs.writeFile(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return action;
}

/**
 * Configures local project MCP settings for selected agent harnesses.
 */
export async function setupHarnessConfigs(
  projectRoot: string,
  harnesses: AgentHarness[]
): Promise<HarnessConfigResult[]> {
  const results: HarnessConfigResult[] = [];
  const selectedSet = new Set(harnesses.map(h => h.toLowerCase()));

  const shouldApply = (h: AgentHarness) => selectedSet.has('all') || selectedSet.has(h);

  if (selectedSet.has('skip')) {
    return results;
  }

  // 1. Claude Code (.mcp.json)
  if (shouldApply('claude')) {
    const file = join(projectRoot, '.mcp.json');
    const action = await writeStandardMcpConfig(file, 'mcpServers');
    results.push({ harness: 'Claude Code', file: '.mcp.json', action });
  }

  // 2. Cursor (.cursor/mcp.json)
  if (shouldApply('cursor')) {
    const file = join(projectRoot, '.cursor', 'mcp.json');
    const action = await writeStandardMcpConfig(file, 'mcpServers');
    results.push({ harness: 'Cursor', file: '.cursor/mcp.json', action });
  }

  // 3. VS Code / Codex (.vscode/mcp.json)
  if (shouldApply('vscode') || shouldApply('codex')) {
    const file = join(projectRoot, '.vscode', 'mcp.json');
    const action = await writeStandardMcpConfig(file, 'servers');
    results.push({ harness: 'VS Code / Codex', file: '.vscode/mcp.json', action });
  }

  // 4. OpenCode (opencode.json)
  if (shouldApply('opencode')) {
    const file = join(projectRoot, 'opencode.json');
    const action = await writeOpenCodeConfig(file);
    results.push({ harness: 'OpenCode', file: 'opencode.json', action });
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
    const action = await writeStandardMcpConfig(file, 'mcpServers');
    results.push({ harness: 'Goose', file: '.goose/mcp.json', action });
  }

  // 7. Pi / Oh My Pi (.pi/mcp.json)
  if (shouldApply('pi')) {
    const file = join(projectRoot, '.pi', 'mcp.json');
    const action = await writeStandardMcpConfig(file, 'mcpServers');
    results.push({ harness: 'Pi / Oh My Pi', file: '.pi/mcp.json', action });
  }

  return results;
}
