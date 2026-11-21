import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendTomlMcpServer, parseTomlSafe, setupHarnessConfigs } from '../../src/cli/mcp-configs';
import { detectExistingHarnesses, detectProjectProfile, handleStrataInit, parseHarnessArg } from '../../src/cli/commands/init';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL, STRATA_TS_RULE, STRATA_TS_SKILL } from '../../src/cli/templates';
import { STRATA_INSTRUCTIONS } from '../../src/instructions';
import { createWorkspaceTracker } from '../_helpers/workspace';

const workspaces = createWorkspaceTracker();
const tempDir = () => workspaces.create('strata-init-test-');

afterEach(() => {
  workspaces.cleanupAll();
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
  expect(existsSync(join(root, '.claude', 'commands', 'use-strata.md'))).toBe(true);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(true);
  expect(existsSync(join(root, '.claude', 'rules'))).toBe(false);

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
  expect(existsSync(join(root, '.gemini', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'mcp_config.json'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'hooks.json'))).toBe(true);

  const geminiRule = readFileSync(join(root, '.gemini', 'rules', 'strata-frontend.md'), 'utf8');
  const geminiMd = readFileSync(join(root, 'GEMINI.md'), 'utf8');
  expect(geminiRule).toBe(STRATA_FRONTEND_RULE);
  expect(geminiMd).not.toContain('Tool Routing Matrix');
  expect(geminiMd).toContain('.gemini/rules/strata-frontend.md');

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
  expect(existsSync(join(root, '.codex', 'rules'))).toBe(false);
  expect(existsSync(join(root, '.codex', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
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
  expect(existsSync(join(root, 'opencode', 'rules'))).toBe(false);
  expect(existsSync(join(root, 'opencode', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
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
  expect(existsSync(join(root, '.agents', 'rules'))).toBe(false);
  expect(existsSync(join(root, '.agents', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'hooks', 'strata-post-write.sh'))).toBe(true);
  expect(existsSync(join(root, '.agents', 'hooks.json'))).toBe(true);
});

test('multi-harness init deduplicates identical Antigravity rule and skill copies and skips GEMINI.md', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"vue-app","dependencies":{"vue":"3"}}');
  writeFileSync(join(root, 'App.vue'), '<template><div>Test</div></template>');

  await handleStrataInit({
    cwd: root,
    harness: 'all',
    yes: true,
  });

  const agentsDoc = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const geminiRule = readFileSync(join(root, '.gemini', 'rules', 'strata-frontend.md'), 'utf8');
  expect(agentsDoc).toBe(STRATA_FRONTEND_RULE);
  expect(geminiRule).not.toBe(STRATA_FRONTEND_RULE);
  expect(geminiRule).toContain('AGENTS.md');
  expect(geminiRule).toContain('strata-mcp');
  expect(geminiRule).toContain('inspect_component');
  expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
  expect(existsSync(join(root, '.agents', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, '.gemini', 'skills', 'use-strata', 'SKILL.md'))).toBe(false);
});

test('non-UI TypeScript project receives concise TS/JS guidance instead of Vue/Nuxt/Pinia rules', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'spector-mcp',
    devDependencies: { typescript: '^5.0.0', '@types/node': '^22.0.0' },
  }));
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export function main() { return 1; }\n');

  const profile = await detectProjectProfile(root);
  expect(profile.isUiProject).toBe(false);

  await handleStrataInit({
    cwd: root,
    harness: 'all',
    yes: true,
  });

  const agentsDoc = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const skillDoc = readFileSync(join(root, '.agents', 'skills', 'use-strata', 'SKILL.md'), 'utf8');
  expect(agentsDoc).toBe(STRATA_TS_RULE);
  expect(skillDoc).toBe(STRATA_TS_SKILL);
  expect(agentsDoc).not.toMatch(/Pinia|Nuxt|Svelte|Astro|Inertia|Zustand/i);
  expect(skillDoc).not.toMatch(/Pinia|Nuxt|Svelte|Astro|Inertia|Zustand|v-model/i);
});

test('init without --harness scopes automatically to detected workspace client folders', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'package.json'), '{"name":"cli-app"}');
  mkdirSync(join(root, '.claude'), { recursive: true });

  expect(detectExistingHarnesses(root)).toEqual(['claude']);

  await handleStrataInit({
    cwd: root,
    yes: true,
  });

  expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  expect(existsSync(join(root, '.gemini'))).toBe(false);
  expect(existsSync(join(root, '.codex'))).toBe(false);
  expect(existsSync(join(root, 'opencode.json'))).toBe(false);
});

test('does not climb to parent directory containing package.json when initializing child', async () => {
  const parent = tempDir();
  writeFileSync(join(parent, 'package.json'), '{"name":"parent"}');
  const child = join(parent, 'child');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, 'App.vue'), '<template><div>Child</div></template>');

  await handleStrataInit({ cwd: child, harness: 'skip', yes: true });

  expect(existsSync(join(child, '.strata', 'graph.db'))).toBe(true);
  expect(existsSync(join(parent, '.strata', 'graph.db'))).toBe(false);
});

test('preserves custom fields in existing strata server config without --force, overwrites with --force', async () => {
  const root = tempDir();
  const mcpPath = join(root, '.mcp.json');
  const customConfig = {
    mcpServers: {
      strata: {
        command: '/custom/bun',
        args: ['/custom/strata.js', 'serve'],
        env: { CUSTOM: 'preserve' },
        disabled: true,
      },
      other: { command: 'other-cli' },
    },
  };
  writeFileSync(mcpPath, JSON.stringify(customConfig, null, 2));

  const resultsNoForce = await setupHarnessConfigs(root, ['claude'], false);
  expect(resultsNoForce[0]?.action).toBe('skipped');
  const readBack1 = JSON.parse(readFileSync(mcpPath, 'utf8'));
  expect(readBack1.mcpServers.strata).toEqual(customConfig.mcpServers.strata);
  expect(readBack1.mcpServers.other).toEqual(customConfig.mcpServers.other);

  const resultsForce = await setupHarnessConfigs(root, ['claude'], true);
  expect(resultsForce[0]?.action).toBe('updated');
  const readBack2 = JSON.parse(readFileSync(mcpPath, 'utf8'));
  expect(readBack2.mcpServers.strata).toEqual({ command: 'strata', args: ['serve'] });
  expect(readBack2.mcpServers.other).toEqual(customConfig.mcpServers.other);
});

test('handles quoted TOML keys without duplicating table and updates existing Codex TOML on --force', () => {
  const root1 = tempDir();
  const tomlPath1 = join(root1, 'config.toml');
  const initialQuoted = '[mcp_servers."strata"]\ncommand = "custom"\nargs = []\n';
  writeFileSync(tomlPath1, initialQuoted);

  const resNoForce = appendTomlMcpServer(tomlPath1, 'strata', 'strata', ['serve'], false);
  expect(resNoForce.action).toBe('skipped');
  const content1 = readFileSync(tomlPath1, 'utf8');
  expect(parseTomlSafe(content1).valid).toBe(true);
  expect(content1.trim()).toBe(initialQuoted.trim());

  const root2 = tempDir();
  const tomlPath2 = join(root2, 'config.toml');
  writeFileSync(tomlPath2, '[mcp_servers.strata]\ncommand = "broken-launcher"\nargs = ["old"]\n');

  const resForce = appendTomlMcpServer(tomlPath2, 'strata', 'strata', ['serve'], true);
  expect(resForce.action).toBe('updated');
  const updated = readFileSync(tomlPath2, 'utf8');
  expect(parseTomlSafe(updated).valid).toBe(true);
  expect(updated).toContain('command = "strata"');
  expect(updated).toContain('args = ["serve"]');
  expect(updated).not.toContain('broken-launcher');
});

test('--force restores 0o755 executable permissions on pre-existing non-executable hook', async () => {
  const root = tempDir();
  const hooksDir = join(root, '.agents', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookFile = join(hooksDir, 'strata-post-write.sh');
  writeFileSync(hookFile, '#!/bin/sh\nexit 0\n');
  chmodSync(hookFile, 0o644);
  expect(statSync(hookFile).mode & 0o777).toBe(0o644);

  await handleStrataInit({ cwd: root, harness: 'skip', force: true, yes: true });

  expect(statSync(hookFile).mode & 0o777).toBe(0o755);
});

test('rejects malformed JSON configuration and preserves file without corruption', async () => {
  const root = tempDir();
  const mcpPath = join(root, '.mcp.json');
  const brokenContent = '{ broken: json';
  writeFileSync(mcpPath, brokenContent);

  await expect(handleStrataInit({ cwd: root, harness: 'claude', yes: true })).rejects.toThrow(
    /Configuration failed for harness/
  );
  expect(readFileSync(mcpPath, 'utf8')).toBe(brokenContent);
});

test('parseHarnessArg validates aliases, numeric choices, and rejects unknown harnesses', async () => {
  expect(() => parseHarnessArg('cluade')).toThrow(/Unknown agent harness: 'cluade'/);
  expect(() => parseHarnessArg('invalid')).toThrow(/Unknown agent harness: 'invalid'/);
  expect(() => parseHarnessArg('pi')).toThrow(/Unknown agent harness: 'pi'/);
  expect(parseHarnessArg('')).toEqual(['all']);
  expect(parseHarnessArg('all')).toEqual(['all']);
  expect(parseHarnessArg('skip')).toEqual(['skip']);
  expect(parseHarnessArg('antigravity')).toEqual(['antigravity']);
  expect(parseHarnessArg('gemini')).toEqual(['antigravity']);
  expect(parseHarnessArg('opencode')).toEqual(['opencode']);
  expect(parseHarnessArg('agents')).toEqual(['agents']);
  expect(parseHarnessArg('.agents')).toEqual(['agents']);
  expect(parseHarnessArg('3')).toEqual(['codex']);
  expect(parseHarnessArg('codex')).toEqual(['codex']);
  expect(parseHarnessArg('openai-codex')).toEqual(['codex']);

  const rootChoice3 = tempDir();
  const results3 = await setupHarnessConfigs(rootChoice3, parseHarnessArg('3'));
  expect(results3).toHaveLength(1);
  expect(results3[0].harness).toBe('Codex');
  expect(existsSync(join(rootChoice3, '.codex', 'config.toml'))).toBe(true);
});

test('ensures active .strata/ rule in .gitignore and creates .strata/.gitignore', async () => {
  const root = tempDir();
  const gitignorePath = join(root, '.gitignore');
  writeFileSync(gitignorePath, '# .strata cache goes here\n');

  await handleStrataInit({ cwd: root, harness: 'skip', yes: true });

  expect(readFileSync(gitignorePath, 'utf8')).toContain('.strata/');
  expect(existsSync(join(root, '.strata', '.gitignore'))).toBe(true);
  expect(readFileSync(join(root, '.strata', '.gitignore'), 'utf8')).toBe('*\n');
});

