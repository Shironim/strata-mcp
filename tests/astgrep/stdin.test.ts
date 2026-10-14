import { expect, test } from 'bun:test';
import { executeAstGrep } from '../../src/engine/astgrep';

test('passes complete Unicode stdin to ast-grep instead of reporting missing input as zero matches', async () => {
  const code = '// padding\n'.repeat(10000) + 'console.log("selamat 🌊");\n';
  const matches = await executeAstGrep({ code, pattern: 'console.log($$$)', language: 'ts' });
  expect(matches).toHaveLength(1);
  expect(matches[0].text).toBe('console.log("selamat 🌊")');
  expect(matches[0].line).toBe(10001);
});
