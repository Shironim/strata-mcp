import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { handleStrataInit } from '../../src/cli/commands/init';
import { closeAllDatabases } from '../../src/engine/database';

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
    const skillFile = join(testDir, '.agents/skills/strata-inspect/SKILL.md');
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
    expect(skillContent).toContain('strata-inspect');
  });

  it('runs idempotently without failing or corrupting configuration', async () => {
    await handleStrataInit({ cwd: testDir, yes: true });
    // Run second time
    await expect(handleStrataInit({ cwd: testDir, yes: true })).resolves.toBeUndefined();
  });
});
