import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleStrataInit, parseHarnessArg } from '../../src/cli/commands/init';
import { setupHarnessConfigs, appendTomlMcpServer, parseTomlSafe } from '../../src/cli/mcp-configs';
import { closeAllDatabases } from '../../src/engine/database';

const tempRoots: string[] = [];
function tempDir(prefix = 'strata-audit-fix-'): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  closeAllDatabases();
  tempRoots.splice(0).forEach(r => {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  });
});

describe('Audit Bug Fixes: INIT-01 to INIT-11', () => {
  // INIT-01: Target default / '.' bergeser ke root induk
  it('INIT-01: does not climb to parent directory containing package.json when initializing child', async () => {
    const parent = tempDir('init-01-parent-');
    writeFileSync(join(parent, 'package.json'), '{"name":"parent"}');
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'App.vue'), '<template><div>Child</div></template>');

    await handleStrataInit({ cwd: child, harness: 'skip', yes: true });

    expect(existsSync(join(child, '.strata', 'graph.db'))).toBe(true);
    expect(existsSync(join(parent, '.strata', 'graph.db'))).toBe(false);
  });

  // INIT-02: Existing JSON server entry hilang tanpa --force
  it('INIT-02: preserves custom fields in existing strata server config without --force, overwrites with --force', async () => {
    const root = tempDir('init-02-json-');
    const mcpPath = join(root, '.mcp.json');
    const customConfig = {
      mcpServers: {
        strata: {
          command: '/custom/bun',
          args: ['/custom/strata.js', 'serve'],
          env: { CUSTOM: 'preserve' },
          disabled: true,
        },
        other: {
          command: 'other-cli',
        },
      },
    };
    writeFileSync(mcpPath, JSON.stringify(customConfig, null, 2));

    // Without force: strata entry must remain identical
    const resultsNoForce = await setupHarnessConfigs(root, ['claude'], false);
    expect(resultsNoForce[0]?.action).toBe('skipped');

    const readBack1 = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(readBack1.mcpServers.strata).toEqual(customConfig.mcpServers.strata);
    expect(readBack1.mcpServers.other).toEqual(customConfig.mcpServers.other);

    // With force: strata entry is updated to canonical, other server preserved
    const resultsForce = await setupHarnessConfigs(root, ['claude'], true);
    expect(resultsForce[0]?.action).toBe('updated');

    const readBack2 = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(readBack2.mcpServers.strata).toEqual({ command: 'strata', args: ['serve'] });
    expect(readBack2.mcpServers.other).toEqual(customConfig.mcpServers.other);
  });

  // INIT-03: TOML quoted key valid dirusak menjadi duplicate table
  it('INIT-03: handles quoted TOML keys without duplicating table', () => {
    const root = tempDir('init-03-toml-');
    const tomlPath = join(root, 'config.toml');
    const initialToml = '[mcp_servers."strata"]\ncommand = "custom"\nargs = []\n';
    writeFileSync(tomlPath, initialToml);

    // Without force: table should be skipped, no duplicate table created
    const resNoForce = appendTomlMcpServer(tomlPath, 'strata', 'strata', ['serve'], false);
    expect(resNoForce.action).toBe('skipped');

    const content1 = readFileSync(tomlPath, 'utf8');
    const parsed1 = parseTomlSafe(content1);
    expect(parsed1.valid).toBe(true);
    expect(content1.trim()).toBe(initialToml.trim());
  });

  // INIT-04 & INIT-05: Hook reads stdin JSON and syncs workspace root
  it('INIT-04 & INIT-05: hook script template extracts file path from stdin and syncs workspace root', () => {
    const root = tempDir('init-04-05-hook-');
    mkdirSync(join(root, '.agents', 'hooks'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'App.vue'), '<template><div/></template>');

    // Initialize to get hook script
    const hookPath = join(root, '.agents', 'hooks', 'strata-post-write.sh');
    const hookTemplate = readFileSync(join(import.meta.dir, '../../src/cli/templates.ts'), 'utf8');
    expect(hookTemplate).toContain('tool_input?.file_path');
    expect(hookTemplate).toContain('WORKSPACE_ROOT=');
    expect(hookTemplate).not.toContain('dirname "$FILE_PATH"');
  });

  // INIT-06: --force updates Codex config existing
  it('INIT-06: --force updates existing Codex TOML entry', () => {
    const root = tempDir('init-06-codex-');
    const tomlPath = join(root, 'config.toml');
    const initialToml = '[mcp_servers.strata]\ncommand = "broken-launcher"\nargs = ["old"]\n';
    writeFileSync(tomlPath, initialToml);

    const res = appendTomlMcpServer(tomlPath, 'strata', 'strata', ['serve'], true);
    expect(res.action).toBe('updated');

    const updated = readFileSync(tomlPath, 'utf8');
    const parsed = parseTomlSafe(updated);
    expect(parsed.valid).toBe(true);
    expect(updated).toContain('command = "strata"');
    expect(updated).toContain('args = ["serve"]');
    expect(updated).not.toContain('broken-launcher');
  });

  // INIT-07: Overwrite hook restores executable permission (0o755)
  it('INIT-07: --force restores 0o755 executable permissions on pre-existing non-executable hook', async () => {
    const root = tempDir('init-07-perm-');
    const hooksDir = join(root, '.agents', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = join(hooksDir, 'strata-post-write.sh');
    writeFileSync(hookFile, '#!/bin/sh\nexit 0\n');
    chmodSync(hookFile, 0o644);

    expect(statSync(hookFile).mode & 0o777).toBe(0o644);

    await handleStrataInit({ cwd: root, harness: 'skip', force: true, yes: true });

    const modeAfter = statSync(hookFile).mode & 0o777;
    expect(modeAfter).toBe(0o755);
  });

  // INIT-08: Malformed configs are reported as failed and trigger failure
  it('INIT-08: rejects malformed JSON configuration and does not report it as configured', async () => {
    const root = tempDir('init-08-malformed-');
    const mcpPath = join(root, '.mcp.json');
    const brokenContent = '{ broken: json';
    writeFileSync(mcpPath, brokenContent);

    await expect(handleStrataInit({ cwd: root, harness: 'claude', yes: true })).rejects.toThrow(
      /Configuration failed for harness/
    );

    // File content must be preserved without corruption
    expect(readFileSync(mcpPath, 'utf8')).toBe(brokenContent);
  });

  // INIT-09: Invalid harness names are rejected before writes
  it('INIT-09: parseHarnessArg throws on unknown harness values', () => {
    expect(() => parseHarnessArg('cluade')).toThrow(/Unknown agent harness: 'cluade'/);
    expect(() => parseHarnessArg('invalid')).toThrow(/Unknown agent harness: 'invalid'/);
    expect(parseHarnessArg('')).toEqual(['all']);
    expect(parseHarnessArg('all')).toEqual(['all']);
    expect(parseHarnessArg('skip')).toEqual(['skip']);
  });

  // INIT-10: Menu option '3' configures both VS Code and Codex
  it('INIT-10: choice "3" configures both VS Code and Codex; "codex" only configures Codex', async () => {
    expect(parseHarnessArg('3')).toEqual(['vscode', 'codex']);
    expect(parseHarnessArg('vscode')).toEqual(['vscode']);
    expect(parseHarnessArg('codex')).toEqual(['codex']);

    const rootCodexOnly = tempDir('init-10-codex-only-');
    const resultsCodex = await setupHarnessConfigs(rootCodexOnly, ['codex']);
    expect(resultsCodex).toHaveLength(1);
    expect(resultsCodex[0].harness).toBe('Codex');
    expect(existsSync(join(rootCodexOnly, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(rootCodexOnly, '.vscode', 'mcp.json'))).toBe(false);

    const rootChoice3 = tempDir('init-10-choice3-');
    const results3 = await setupHarnessConfigs(rootChoice3, parseHarnessArg('3'));
    expect(results3).toHaveLength(2);
    expect(existsSync(join(rootChoice3, '.vscode', 'mcp.json'))).toBe(true);
    expect(existsSync(join(rootChoice3, '.codex', 'config.toml'))).toBe(true);
  });

  // INIT-11: Substring in .gitignore comment doesn't prevent adding .strata/
  it('INIT-11: ensures active .strata/ rule in .gitignore and creates .strata/.gitignore', async () => {
    const root = tempDir('init-11-ignore-');
    const gitignorePath = join(root, '.gitignore');
    writeFileSync(gitignorePath, '# .strata cache goes here\n');

    await handleStrataInit({ cwd: root, harness: 'skip', yes: true });

    const content = readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('.strata/');
    // Verify .strata/.gitignore is also created with *
    expect(existsSync(join(root, '.strata', '.gitignore'))).toBe(true);
    expect(readFileSync(join(root, '.strata', '.gitignore'), 'utf8')).toBe('*\n');
  });
});
