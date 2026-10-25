import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupHarnessConfigs } from '../../src/cli/mcp-configs';
import { handleStrataInit } from '../../src/cli/commands/init';
import { closeAllDatabases } from '../../src/engine/storage/schema';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL } from '../../src/cli/templates';
import { STRATA_INSTRUCTIONS } from '../../src/instructions';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync('/tmp/strata-init-test-');
  roots.push(dir);
  return dir;
}

afterEach(() => {
  closeAllDatabases();
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});

test('setupHarnessConfigs generates Claude Code .mcp.json correctly', async () => {
  const root = tempDir();
  const results = await setupHarnessConfigs(root, ['claude']);

  expect(results.length).toBe(1);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);

  const parsed = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  expect(parsed.mcpServers?.strata?.command).toBe('strata');
  expect(parsed.mcpServers?.strata?.args).toEqual(['serve']);
});

test('all harness configurations use the shared server entrypoint without tool allowlists', async () => {
  const root = tempDir();
  const results = await setupHarnessConfigs(root, ['all']);
  expect(results).toHaveLength(5);
  for (const file of ['.mcp.json', '.gemini/mcp_config.json', '.agents/mcp.json']) {
    const data = JSON.parse(readFileSync(join(root, file), 'utf8'));
    const server = (data.mcpServers ?? data.servers).strata;
    expect(server).toEqual({ command: 'strata', args: ['serve'] });
  }
  const opencode = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
  expect(opencode.mcp.strata.command).toEqual(['strata', 'serve']);
  const codex = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  expect(codex).toContain('[mcp_servers.strata]');
});

test('setupHarnessConfigs non-destructively merges existing configs', async () => {
  const root = tempDir();
  const mcpFile = join(root, '.mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { otherTool: { command: 'other' } } }));

  await setupHarnessConfigs(root, ['claude']);

  const parsed = JSON.parse(readFileSync(mcpFile, 'utf8'));
  expect(parsed.mcpServers.otherTool.command).toBe('other');
  expect(parsed.mcpServers.strata.command).toBe('strata');
});

test('setupHarnessConfigs generates OpenCode opencode.json correctly', async () => {
  const root = tempDir();
  await setupHarnessConfigs(root, ['opencode']);

  const parsed = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
  expect(parsed.mcp?.strata?.type).toBe('local');
  expect(parsed.mcp?.strata?.command).toEqual(['strata', 'serve']);
});

test('handleStrataInit initializes project, agent artifacts, and harness config', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"my-app","dependencies":{"vue":"3"}}');
  writeFileSync(join(root, 'App.vue'), '<template><div>Test</div></template>');

  await handleStrataInit({
    cwd: root,
    harness: 'claude',
    yes: true,
  });

  expect(existsSync(join(root, '.strata'))).toBe(true);
  expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  expect(existsSync(join(root, '.claude', 'commands', 'strata-inspect.md'))).toBe(true);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(true);

  const rule = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  expect(rule).toBe(STRATA_FRONTEND_RULE);
  expect(rule).toContain('Map First, Read Selectively');
  expect(rule).toContain('source_ref');
  for (const content of [rule, STRATA_INSPECT_SKILL, STRATA_INSTRUCTIONS]) {
    expect(content).not.toMatch(/get_routes|get_api_contracts/);
    for (const tool of TOOL_CATALOG) expect(content).toContain(tool.name);
    expect(content).toContain('routes');
    expect(content).toContain('api-contracts');
  }
  expect(STRATA_INSTRUCTIONS).toContain('Map first, read selectively');
  expect(STRATA_INSTRUCTIONS).toContain('source_ref');

  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  expect(gitignore).toContain('.strata/');
});

test('handleStrataInit initializes Google Antigravity with .gemini and GEMINI.md', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"my-app","dependencies":{"vue":"3"}}');
  writeFileSync(join(root, 'App.vue'), '<template><div>Test</div></template>');

  await handleStrataInit({
    cwd: root,
    harness: 'antigravity',
    yes: true,
  });

  expect(existsSync(join(root, '.strata'))).toBe(true);
  expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'rules', 'strata-frontend.md'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'skills', 'strata-inspect', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'mcp_config.json'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'hooks.json'))).toBe(true);

  const geminiConfig = JSON.parse(readFileSync(join(root, '.gemini', 'mcp_config.json'), 'utf8'));
  expect(geminiConfig.mcpServers?.strata?.command).toBe('strata');
});

test('setupHarnessConfigs defensively preserves malformed JSON without data loss', async () => {
  const root = tempDir();
  const mcpFile = join(root, '.mcp.json');
  const malformedContent = '{\n  "corrupt": true,,\n}';
  writeFileSync(mcpFile, malformedContent);

  const results = await setupHarnessConfigs(root, ['claude']);
  expect(results[0]?.action).toBe('failed');

  // Content must be preserved identically
  const contentAfter = readFileSync(mcpFile, 'utf8');
  expect(contentAfter).toBe(malformedContent);
});

test('setupHarnessConfigs configures Claude and Antigravity lifecycle hooks', async () => {
  const root = tempDir();
  await setupHarnessConfigs(root, ['claude', 'antigravity']);

  const claudeSettings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  expect(claudeSettings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('strata-post-write.sh');

  const geminiHooks = JSON.parse(readFileSync(join(root, '.gemini', 'hooks.json'), 'utf8'));
  expect(geminiHooks['strata-autosync']).toBeDefined();
});

test('setupHarnessConfigs configures Codex CLI config.toml', async () => {
  const root = tempDir();
  await setupHarnessConfigs(root, ['codex']);

  const tomlPath = join(root, '.codex', 'config.toml');
  expect(existsSync(tomlPath)).toBe(true);

  const tomlContent = readFileSync(tomlPath, 'utf8');
  expect(tomlContent).toContain('[mcp_servers.strata]');
  expect(tomlContent).toContain('command = "strata"');
});

test('handleStrataInit initializes OpenAI Codex with AGENTS.md, config.toml, skills, and hooks', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"my-app"}');

  await handleStrataInit({
    cwd: root,
    harness: 'codex',
    yes: true,
  });

  expect(existsSync(join(root, '.strata'))).toBe(true);
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(true);
  expect(existsSync(join(root, '.codex', 'rules', 'strata-frontend.md'))).toBe(true);
  expect(existsSync(join(root, '.codex', 'skills', 'strata-inspect', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.codex', 'hooks', 'strata-post-write.sh'))).toBe(true);
  expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(true);

  const agentsRule = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(agentsRule).toContain('strata-mcp');
});

test('handleStrataInit initializes OpenCode in opencode folder with skills, hooks, and mcp configs', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"my-app"}');

  await handleStrataInit({
    cwd: root,
    harness: 'opencode',
    yes: true,
  });

  expect(existsSync(join(root, '.strata'))).toBe(true);
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  expect(existsSync(join(root, 'opencode.json'))).toBe(true);
  expect(existsSync(join(root, 'opencode', 'rules', 'strata-frontend.md'))).toBe(true);
  expect(existsSync(join(root, 'opencode', 'skills', 'strata-inspect', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, 'opencode', 'hooks', 'strata-post-write.sh'))).toBe(true);
  expect(existsSync(join(root, 'opencode', 'hooks.json'))).toBe(true);
});

test('handleStrataInit initializes .agents general harness with skills, hooks, and mcp configs', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"my-app"}');

  await handleStrataInit({
    cwd: root,
    harness: 'agents',
    yes: true,
  });

  expect(existsSync(join(root, '.strata'))).toBe(true);
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'mcp.json'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'rules', 'strata-frontend.md'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'skills', 'strata-inspect', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'hooks', 'strata-post-write.sh'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'hooks.json'))).toBe(true);
});

