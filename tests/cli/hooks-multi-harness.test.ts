import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupHarnessArtifacts, setupHarnessConfigs } from '../../src/cli/mcp-configs';
import { parseHarnessArg } from '../../src/cli/commands/init';
import { STRATA_POST_WRITE_HOOK } from '../../src/cli/templates';

async function makeTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'strata-hooks-test-'));
}

describe('multi-harness hooks scaffolding and migration', () => {
  test('scaffolds valid hook configs and scripts for all harnesses', async () => {
    const root = await makeTempWorkspace();
    try {
      await setupHarnessArtifacts(root, ['all'], false, { isUiProject: true });
      const results = await setupHarnessConfigs(root, ['all'], false);

      expect(results.some((r) => r.action === 'failed')).toBe(false);

      // Antigravity / .agents: uses .agents/ (no .gemini/ directory created)
      expect(existsSync(join(root, '.gemini'))).toBe(false);
      expect(existsSync(join(root, '.agents', 'mcp.json'))).toBe(true);
      expect(existsSync(join(root, '.agents', 'rules', 'strata-frontend.md'))).toBe(true);
      expect(existsSync(join(root, '.agents', 'skills', 'use-strata', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(root, '.agents', 'hooks', 'strata-post-write.sh'))).toBe(true);

      const agentsHooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
      expect(agentsHooks['strata-autosync']?.enabled).toBe(true);
      expect(agentsHooks['strata-autosync']?.PostToolUse?.[0]?.matcher).toContain('multi_replace_file_content');
      expect(agentsHooks['strata-autosync']?.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
        './hooks/strata-post-write.sh --antigravity'
      );
      expect(agentsHooks.hooks).toBeUndefined();

      // Claude Code: .claude/settings.json
      const claudeSettings = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
      expect(claudeSettings.hooks?.PostToolUse?.[0]?.matcher).toContain('MultiEdit');
      expect(claudeSettings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('--claude');
      expect(claudeSettings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('CLAUDE_PROJECT_DIR');

      // Codex CLI: .codex/hooks.json (no Bash in matcher)
      const codexHooks = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'));
      expect(codexHooks.hooks?.PostToolUse?.[0]?.matcher).toContain('apply_patch');
      expect(codexHooks.hooks?.PostToolUse?.[0]?.matcher).not.toContain('Bash');
      expect(codexHooks.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('--codex');

      // OpenCode v2: opencode.json uses mcp.strata only (no mcp.servers) + .opencode/plugin/strata-autosync.ts
      const opencodeJson = JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8'));
      expect(opencodeJson.mcp?.strata?.type).toBe('local');
      expect(opencodeJson.mcp?.servers).toBeUndefined();
      expect(existsSync(join(root, 'opencode', 'hooks.json'))).toBe(false);
      expect(existsSync(join(root, 'opencode', 'hooks', 'strata-post-write.sh'))).toBe(false);
      const opencodePlugin = await readFile(join(root, '.opencode', 'plugin', 'strata-autosync.ts'), 'utf8');
      expect(opencodePlugin).toContain('managed-marker: opencode-v2 strata-autosync');
      expect(opencodePlugin).toContain("ctx?.tool?.hook?.('execute.after'");
      expect(opencodePlugin).toContain('__health_probe__');
      expect(opencodePlugin).toContain('windowsHide: true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('auto-migrates stale managed hooks without --force while preserving user hooks', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(join(root, '.agents', 'hooks'), { recursive: true });
      await mkdir(join(root, '.gemini', 'hooks'), { recursive: true });
      await mkdir(join(root, '.claude'), { recursive: true });
      await mkdir(join(root, '.codex'), { recursive: true });
      await mkdir(join(root, 'opencode', 'hooks'), { recursive: true });

      // Legacy .agents/hooks.json with septum-boundary-guard + invalid hooks array
      await writeFile(
        join(root, '.agents', 'hooks.json'),
        JSON.stringify(
          {
            'septum-boundary-guard': { PreToolUse: [{ matcher: 'write_file', hooks: [] }] },
            hooks: [
              { event: 'post_tool_use', matcher: 'write', command: '.agents/hooks/strata-post-write.sh' },
              { event: 'post_tool_use', matcher: 'bash', command: './custom-user-hook.sh' },
            ],
          },
          null,
          2
        )
      );

      // Legacy .gemini/hooks.json with strata-autosync + user namespace
      await writeFile(
        join(root, '.gemini', 'hooks.json'),
        JSON.stringify(
          {
            'strata-autosync': { PostToolUse: [] },
            'user-custom-guard': { PreToolUse: [] },
          },
          null,
          2
        )
      );
      await writeFile(join(root, '.gemini', 'hooks', 'strata-post-write.sh'), '# Strata-MCP Post-Write\n');

      // Legacy .claude/settings.json and .codex/hooks.json with user hooks + stale strata hook
      await writeFile(
        join(root, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: './user-claude.sh' }] },
              { matcher: 'Write', hooks: [{ type: 'command', command: 'strata-post-write.sh' }] },
            ],
          },
        })
      );
      await writeFile(
        join(root, '.codex', 'hooks.json'),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: './user-codex.sh' }] },
              { matcher: 'write', hooks: [{ type: 'command', command: 'strata-post-write.sh' }] },
            ],
          },
        })
      );

      // Legacy opencode/hooks.json
      await writeFile(
        join(root, 'opencode', 'hooks.json'),
        JSON.stringify({
          hooks: [{ event: 'post_tool_use', command: 'opencode/hooks/strata-post-write.sh' }],
        })
      );
      await writeFile(join(root, 'opencode', 'hooks', 'strata-post-write.sh'), '# Strata-MCP Post-Write\n');

      await setupHarnessArtifacts(root, ['all'], false, { isUiProject: true });
      await setupHarnessConfigs(root, ['all'], false);

      // Verify .agents/hooks.json preserved septum-boundary-guard & user hook, migrated strata-autosync
      const agentsHooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
      expect(agentsHooks['septum-boundary-guard']).toBeDefined();
      expect(agentsHooks['strata-autosync']?.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
        './hooks/strata-post-write.sh --antigravity'
      );
      expect(agentsHooks.hooks).toHaveLength(1);
      expect(agentsHooks.hooks[0].command).toBe('./custom-user-hook.sh');

      // Verify .gemini/hooks.json removed strata-autosync but kept user-custom-guard
      const geminiHooks = JSON.parse(await readFile(join(root, '.gemini', 'hooks.json'), 'utf8'));
      expect(geminiHooks['strata-autosync']).toBeUndefined();
      expect(geminiHooks['user-custom-guard']).toBeDefined();
      expect(existsSync(join(root, '.gemini', 'hooks', 'strata-post-write.sh'))).toBe(false);

      // Verify Claude & Codex kept user hooks and updated strata hook
      const claude = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
      expect(claude.hooks.PostToolUse).toHaveLength(2);
      expect(claude.hooks.PostToolUse[0].hooks[0].command).toBe('./user-claude.sh');
      expect(claude.hooks.PostToolUse[1].matcher).toContain('MultiEdit');

      const codex = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'));
      expect(codex.hooks.PostToolUse).toHaveLength(2);
      expect(codex.hooks.PostToolUse[0].hooks[0].command).toBe('./user-codex.sh');
      expect(codex.hooks.PostToolUse[1].matcher).toContain('apply_patch');

      // Verify legacy opencode/hooks.json removed
      expect(existsSync(join(root, 'opencode', 'hooks.json'))).toBe(false);
      expect(existsSync(join(root, 'opencode', 'hooks', 'strata-post-write.sh'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves malformed JSON configs untouched', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(join(root, '.claude'), { recursive: true });
      const rawBroken = '{ "hooks": [ broken json ';
      await writeFile(join(root, '.claude', 'settings.json'), rawBroken);

      const results = await setupHarnessConfigs(root, ['claude'], false);
      const hookResult = results.find((r) => r.file === '.claude/settings.json');
      expect(hookResult?.action).toBe('failed');
      expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toBe(rawBroken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('multi-harness post-write hook runtime contracts', () => {
  async function setupRuntimeFixture() {
    const root = await makeTempWorkspace();
    const binDir = join(root, 'bin');
    const agentsDir = join(root, '.agents');
    const hooksDir = join(agentsDir, 'hooks');
    const strataDir = join(root, '.strata');
    await mkdir(binDir, { recursive: true });
    await mkdir(hooksDir, { recursive: true });
    await mkdir(strataDir, { recursive: true });

    const logFile = join(root, 'sync-calls.log');
    const stubStrata = join(binDir, 'strata');
    await writeFile(
      stubStrata,
      `#!/usr/bin/env sh\necho "$@" >> "${logFile}"\n`,
      { mode: 0o755 }
    );
    await chmod(stubStrata, 0o755);

    const hookScript = join(hooksDir, 'strata-post-write.sh');
    await writeFile(hookScript, STRATA_POST_WRITE_HOOK, { mode: 0o755 });
    await chmod(hookScript, 0o755);

    return { root, binDir, agentsDir, hookScript, logFile };
  }

  async function runHook(
    hookScript: string,
    args: string[],
    stdinPayload: string,
    cwd: string,
    binDir: string
  ) {
    const proc = Bun.spawn(['bash', hookScript, ...args], {
      cwd,
      stdin: new Response(stdinPayload).body!,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  test('Antigravity mode: resolves root from .agents/ cwd, parses TargetFile, outputs {}', async () => {
    const { root, binDir, agentsDir, hookScript, logFile } = await setupRuntimeFixture();
    try {
      const payload = JSON.stringify({
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: join(root, 'src', 'App.vue') },
        },
        hookEventName: 'PostToolUse',
      });
      const res = await runHook(hookScript, ['--antigravity'], payload, agentsDir, binDir);
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe('{}');

      // Wait briefly for detached background worker to write stub log
      await Bun.sleep(150);
      const log = await readFile(logFile, 'utf8');
      expect(log).toContain(`sync ${root} --json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Codex mode: parses apply_patch tool_input.command and keeps stdout strictly empty', async () => {
    const { root, binDir, hookScript, logFile } = await setupRuntimeFixture();
    try {
      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: '*** Begin Patch\n*** Update File: src/components/Card.tsx\n@@\n+const x = 1;\n*** End Patch',
        },
      });
      const res = await runHook(hookScript, ['--codex'], payload, root, binDir);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');

      await Bun.sleep(150);
      const log = await readFile(logFile, 'utf8');
      expect(log).toContain(`sync ${root} --json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Codex mode: skips non-mutating Bash payload with empty stdout and no sync', async () => {
    const { root, binDir, hookScript, logFile } = await setupRuntimeFixture();
    try {
      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      });
      const res = await runHook(hookScript, ['--codex'], payload, root, binDir);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');

      await Bun.sleep(100);
      expect(existsSync(logFile)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OpenCode v2 plugin exports id/setup and registers execute.after cleanly', async () => {
    const root = await makeTempWorkspace();
    try {
      await setupHarnessConfigs(root, ['opencode'], false);
      const pluginMod = await import(join(root, '.opencode', 'plugin', 'strata-autosync.ts'));
      const def = pluginMod.default;
      expect(def.id).toBe('strata-autosync');
      expect(typeof def.setup).toBe('function');

      const registered: Array<{ event: string; fn: (s: any) => Promise<void> }> = [];
      def.setup({
        directory: root,
        tool: {
          hook: (event: string, fn: (s: any) => Promise<void>) => {
            registered.push({ event, fn });
          },
        },
      });
      expect(registered).toHaveLength(1);
      expect(registered[0]!.event).toBe('execute.after');

      // Should fail open without throwing on non-mutating, health probe, or uninitialized workspace
      await registered[0]!.fn({ sessionID: '__health_probe__', tool: 'write', input: { filePath: 'src/App.vue' } });
      await registered[0]!.fn({ tool: 'read', input: { filePath: 'src/App.vue' } });
      await registered[0]!.fn({ tool: 'write', input: { filePath: 'src/App.vue' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('parseHarnessArg supports comma-separated harnesses and rejects unknown tokens', () => {
    expect(parseHarnessArg('claude,codex')).toEqual(['claude', 'codex']);
    expect(parseHarnessArg('antigravity, claude, antigravity')).toEqual(['antigravity', 'claude']);
    expect(() => parseHarnessArg('claude,unknown')).toThrow(/Unknown agent harness/);
  });

  test('auto-upgrades legacy OpenCode v1 plugin without --force', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(join(root, '.opencode', 'plugin'), { recursive: true });
      await writeFile(
        join(root, '.opencode', 'plugin', 'strata-autosync.ts'),
        'export const StrataPlugin = async () => ({ "tool.execute.before": async () => {} }); // strata-autosync\n'
      );
      const results = await setupHarnessConfigs(root, ['opencode'], false);
      const pluginRes = results.find((r) => r.file === '.opencode/plugin/strata-autosync.ts');
      expect(pluginRes?.action).toBe('updated');
      const updated = await readFile(join(root, '.opencode', 'plugin', 'strata-autosync.ts'), 'utf8');
      expect(updated).toContain('managed-marker: opencode-v2 strata-autosync');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Claude wrapper resolves non-git root when executed from .claude/ subdirectory', async () => {
    const { root, binDir, logFile } = await setupRuntimeFixture();
    try {
      const claudeDir = join(root, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await setupHarnessConfigs(root, ['claude'], false);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      const wrapperCmd = settings.hooks.PostToolUse[0].hooks[0].command;

      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'src', 'Button.tsx') },
      });
      const proc = Bun.spawn(['sh', '-c', wrapperCmd], {
        cwd: claudeDir,
        stdin: new Response(payload).body!,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      expect(stdout).toBe('');

      await Bun.sleep(150);
      const log = await readFile(logFile, 'utf8');
      expect(log).toContain(`sync ${root} --json`);
      const hookLog = await readFile(join(root, '.strata', 'hook.log'), 'utf8');
      expect(hookLog).toContain('harness=claude event=synced');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
