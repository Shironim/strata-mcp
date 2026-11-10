import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { handleStrataInit } from '../../src/cli/commands/init';
import { closeAllDatabases, getWorkspaceDatabase, syncWorkspace } from '../../src/engine/database';
import { STRATA_VERSION } from '../../src/version';

describe('strata init command', () => {
  const testDir = join(import.meta.dir, '../fixtures/temp-init-test');

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    closeAllDatabases();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('provisions harness skills, hooks, and rules into target directory', async () => {
    await handleStrataInit({ cwd: testDir, yes: true });

    const geminiRuleFile = join(testDir, '.gemini/rules/strata-frontend.md');
    const agentsDoc = join(testDir, 'AGENTS.md');
    const skillFile = join(testDir, '.agents/skills/use-strata/SKILL.md');
    const hookFile = join(testDir, '.agents/hooks/strata-post-write.sh');
    const strataDb = join(testDir, '.strata/graph.db');

    expect(existsSync(geminiRuleFile)).toBe(true);
    expect(existsSync(agentsDoc)).toBe(true);
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(hookFile)).toBe(true);
    expect(existsSync(strataDb)).toBe(true);
    expect(existsSync(join(testDir, '.agents/rules'))).toBe(false);

    const ruleContent = await fs.readFile(geminiRuleFile, 'utf8');
    expect(ruleContent).toContain('strata-mcp');
    expect(ruleContent).toContain('inspect_component');

    const skillContent = await fs.readFile(skillFile, 'utf8');
    expect(skillContent).toContain('use-strata');
  });

  it('runs idempotently without failing or corrupting configuration', async () => {
    await handleStrataInit({ cwd: testDir, yes: true });
    // Run second time
    await expect(handleStrataInit({ cwd: testDir, yes: true })).resolves.toBeUndefined();
  });

  it('rebuilds unchanged source on every init while normal sync stays incremental', async () => {
    await fs.writeFile(join(testDir, 'Card.tsx'), `import {useCartStore} from './store';
export function Card(){const {items}=useCartStore();return <div>{items.slice(0).length}</div>}`);
    await handleStrataInit({ cwd: testDir, yes: true, harness: 'codex' });
    const db = getWorkspaceDatabase(testDir);
    db.run("UPDATE state_deps SET identifier='stale-parser-result'");
    const before = Number((db.query("SELECT value FROM meta WHERE key='sync_generation'").get() as {value: string}).value);
    expect((await syncWorkspace(testDir)).cacheHit).toBe(true);
    await handleStrataInit({ cwd: testDir, yes: true, harness: 'codex' });
    expect(db.query("SELECT identifier FROM state_deps WHERE identifier='stale-parser-result'").all()).toHaveLength(0);
    expect(db.query("SELECT identifier FROM state_deps WHERE identifier='useCartStore'").all().length).toBeGreaterThan(0);
    expect(db.query("SELECT value FROM meta WHERE key='cache_version'").get()).toEqual({ value: STRATA_VERSION });
    expect(Number((db.query("SELECT value FROM meta WHERE key='sync_generation'").get() as {value: string}).value)).toBeGreaterThan(before);
    expect((await syncWorkspace(testDir)).parserInvocations).toBe(0);
  });

  it('clears untrusted graph data when an init rebuild fails, then recovers', async () => {
    const path = join(testDir, 'Card.vue');
    await fs.writeFile(path, '<template><div/></template>');
    await handleStrataInit({ cwd: testDir, yes: true, harness: 'codex' });
    const db = getWorkspaceDatabase(testDir);
    await fs.writeFile(path, '<template><div></template>');
    await expect(handleStrataInit({ cwd: testDir, yes: true, harness: 'codex' })).rejects.toThrow();
    expect(db.query('SELECT path FROM files').all()).toHaveLength(0);
    expect(db.query("SELECT value FROM meta WHERE key='index_invalid'").get()).toEqual({ value: '1' });
    await fs.writeFile(path, '<template><div/></template>');
    await syncWorkspace(testDir);
    expect(db.query("SELECT value FROM meta WHERE key='index_invalid'").get()).toEqual({ value: '' });
  });
});
