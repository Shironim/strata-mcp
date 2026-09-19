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

  it('provisions .agents rules, skills, and hooks into target directory', async () => {
    await handleStrataInit({ cwd: testDir });

    const ruleFile = join(testDir, '.agents/rules/strata-frontend.md');
    const skillFile = join(testDir, '.agents/skills/strata-inspect/SKILL.md');
    const hookFile = join(testDir, '.agents/hooks/strata-post-write.sh');
    const strataDb = join(testDir, '.strata/graph.db');

    expect(existsSync(ruleFile)).toBe(true);
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(hookFile)).toBe(true);
    expect(existsSync(strataDb)).toBe(true);

    const ruleContent = await fs.readFile(ruleFile, 'utf8');
    expect(ruleContent).toContain('strata-mcp');
    expect(ruleContent).toContain('inspect_component');

    const skillContent = await fs.readFile(skillFile, 'utf8');
    expect(skillContent).toContain('strata-inspect');
  });

  it('runs idempotently without failing or corrupting configuration', async () => {
    await handleStrataInit({ cwd: testDir });
    // Run second time
    await expect(handleStrataInit({ cwd: testDir })).resolves.toBeUndefined();
  });
});
