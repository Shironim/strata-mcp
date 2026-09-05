import { describe, expect, it } from 'bun:test';
import { executeAstGrep, verifyAstGrepBinary, dumpSyntaxTree, isBinaryExecutionError } from '../../src/engine/astgrep';
import { findComponentUsage } from '../../src/engine/search';
import { join } from 'node:path';

describe('ast-grep Engine Wrapper (Task 2 DoD)', () => {
  it('detects ast-grep binary verification status', async () => {
    const status = await verifyAstGrepBinary();
    // Verification should report boolean status and diagnostic path/error
    expect(typeof status.ok).toBe('boolean');
    if (!status.ok) {
      expect(status.error).toBeDefined();
    } else {
      expect(status.path).toBeDefined();
    }
  });

  it('runs simple pattern matching console.log($$$) on TS/JS code', async () => {
    const status = await verifyAstGrepBinary();
    if (!status.ok) {
      console.warn('Skipping test because ast-grep binary is not yet installed: ' + status.error);
      return;
    }

    const code = `
function calculate(a: number, b: number) {
  console.log("calculating sum");
  const sum = a + b;
  console.log("result:", sum);
  return sum;
}
`;

    const matches = await executeAstGrep({
      code,
      pattern: 'console.log($$$)',
      language: 'ts',
    });

    expect(matches.length).toBe(2);
    expect(matches[0].text).toContain('console.log("calculating sum")');
    expect(matches[1].text).toContain('console.log("result:", sum)');
  });

  it('runs relational constraint rule YAML (inside/has/not)', async () => {
    const status = await verifyAstGrepBinary();
    if (!status.ok) {
      console.warn('Skipping test because ast-grep binary is not yet installed: ' + status.error);
      return;
    }

    const code = `
function outer() {
  const insideVar = 10;
  return insideVar;
}

const outsideVar = 20;
`;

    // Rule: find variable declaration that is INSIDE a function declaration
    const ruleYaml = `
id: var-inside-func
message: variable inside function
language: ts
rule:
  pattern: const $VAR = $VAL
  inside:
    kind: function_declaration
    stopBy: end
`;

    const matches = await executeAstGrep({
      code,
      rule: ruleYaml,
      language: 'ts',
    });

    expect(matches.length).toBe(1);
    expect(matches[0].text).toContain('const insideVar = 10;');
  });

  it('dumps syntax tree', async () => {
    const status = await verifyAstGrepBinary();
    if (!status.ok) {
      return;
    }

    const dump = await dumpSyntaxTree('const x = 1;', 'ts');
    expect(dump).toBeDefined();
    expect(dump.length).toBeGreaterThan(0);
  });


  it('correctly identifies binary execution errors vs parse warnings (GAP-06)', () => {
    expect(isBinaryExecutionError(new Error('Failed to execute ast-grep at "ast-grep": spawn ENOENT'))).toBe(true);
    expect(isBinaryExecutionError(new Error('spawn EACCES'))).toBe(true);
    expect(isBinaryExecutionError(new Error('Make sure @ast-grep/cli is installed'))).toBe(true);
    expect(isBinaryExecutionError(new Error('Syntax error on line 4'))).toBe(false);
    expect(isBinaryExecutionError(null)).toBe(false);
  });

  it('transparently bubbles error when ast-grep binary is missing rather than silent failure (GAP-06)', async () => {
    const originalBin = process.env.AST_GREP_BIN;
    process.env.AST_GREP_BIN = 'non_existent_ast_grep_bin_xyz';
    const fixturesDir = join(import.meta.dir, '../fixtures');

    try {
      let threw = false;
      try {
        await findComponentUsage({
          componentName: 'OldButton',
          targetPath: fixturesDir,
          scope: 'both',
        });
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Failed to execute ast-grep');
      }
      expect(threw).toBe(true);
    } finally {
      if (originalBin !== undefined) {
        process.env.AST_GREP_BIN = originalBin;
      } else {
        delete process.env.AST_GREP_BIN;
      }
    }
  });
});
