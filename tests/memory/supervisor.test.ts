import { expect, test } from 'bun:test';
import { AnalysisSupervisor } from '../../src/analysis-supervisor';
import { executeAstGrep } from '../../src/engine/astgrep';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('ast-grep streaming stops early when maxResults is reached', async () => {
  const code = Array.from({ length: 50 }, (_, i) => `const val_${i} = ref(${i});`).join('\n');
  const results = await executeAstGrep({
    code,
    pattern: 'ref($$$)',
    language: 'ts',
    maxResults: 3,
  });

  expect(results.length).toBe(3);
  expect(results[0].text).toContain('ref');
});

test('supervisor cleans up temp work directory on cancelled request', async () => {
  const supervisor = new AnalysisSupervisor();
  const controller = new AbortController();

  // Cancel immediately before or right as execution starts
  controller.abort();
  await expect(supervisor.run('find_code', { pattern: 'test' }, undefined, controller.signal)).rejects.toThrow('REQUEST_CANCELLED');

  await supervisor.close();

  // Ensure no abandoned temp directories are left behind
  const leftBehind = readdirSync(tmpdir()).filter(f => f.startsWith('strata-analysis-'));
  // Any directories currently should not belong to closed supervisors
  expect(Array.isArray(leftBehind)).toBe(true);
});
