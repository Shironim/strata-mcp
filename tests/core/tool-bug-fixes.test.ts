import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodeTool } from '../../src/tools/find-code';
import { sliceSymbol } from '../../src/engine/slicer';
import { traceStateTool } from '../../src/tools/trace-state';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { auditDesignTokens } from '../../src/engine/style-audit';
import { findComponentUsage, formatMatchesAsText } from '../../src/engine/search';
import { extractVueContract } from '../../src/engine/parsers/contract-vue';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';

describe('Tool Bug Fixes & Invariant Regression Suite (tool-bug-fix.md)', () => {
  // -------------------------------------------------------------------------
  // BUG-01: find_code default mode AST validation
  // -------------------------------------------------------------------------
  it('BUG-01: rejects invalid AST patterns when mode is omitted (defaulting to ast), without silent zero-matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bug01-'));
    try {
      writeFileSync(join(root, 'Test.vue'), '<template><div>hello</div></template>');

      // Omitted mode argument -> defaults to 'ast'
      const invalidAst = await findCodeTool.handler({
        path: root,
        pattern: 'resolves tsconfig compilerOptions.paths aliases',
        format: 'json',
      });
      // Must not silently succeed with 0 matches
      expect(invalidAst.isError).toBe(true);

      // Explicit mode 'literal' must search literal text without error
      const literal = await findCodeTool.handler({
        path: root,
        pattern: 'hello',
        mode: 'literal',
        format: 'json',
      });
      expect(literal.isError).toBeUndefined();
      const matches = JSON.parse(literal.content[0].text);
      expect(matches.length).toBeGreaterThan(0);

      // Explicit mode 'auto' on invalid pattern must fall back to literal
      const auto = await findCodeTool.handler({
        path: root,
        pattern: 'resolves tsconfig compilerOptions.paths aliases',
        mode: 'auto',
        format: 'json',
      });
      expect(auto.isError).toBeUndefined();
      expect((auto as any).structuredContent?.fallbackReason).toBe('invalid_ast_pattern');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // BUG-02: sliceSymbol path canonicalization
  // -------------------------------------------------------------------------
  it('BUG-02: resolves callers via sliceSymbol with canonicalized path matching SQLite database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bug02-'));
    try {
      const child = join(root, 'utils.ts');
      const parent = join(root, 'Parent.vue');
      writeFileSync(child, 'export function doSomething() { return 42; }\n');
      writeFileSync(parent, '<script setup>\nimport { doSomething } from "./utils";\n</script><template><div>{{ doSomething() }}</div></template>');

      getWorkspaceDatabase(root, { create: true });
      await syncWorkspace(root);

      const slice = await sliceSymbol({
        path: child,
        symbolName: 'doSomething',
        workspaceRoot: root,
      });

      expect(slice).not.toBeNull();
      expect(slice?.symbolName).toBe('doSomething');
      expect(slice?.blastRadius?.callers.map(c => c.filePath)).toContain(parent);
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // BUG-03: trace_state preflight sync eliminates false stale/INDEX_CHANGED
  // -------------------------------------------------------------------------
  it('BUG-03: trace_state preflight sync prevents false INDEX_CHANGED evidence on disk mutations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bug03-'));
    try {
      getWorkspaceDatabase(root, { create: true });
      const storeFile = join(root, 'useCounter.ts');
      const compFile = join(root, 'CounterView.vue');

      writeFileSync(storeFile, 'export function useCounter() { let count = 0; return { count }; }');
      writeFileSync(compFile, '<script setup>import { useCounter } from "./useCounter"; const c = useCounter();</script><template>{{ c.count }}</template>');

      // Mutate file before calling trace_state
      await syncWorkspace(root);
      writeFileSync(storeFile, 'export function useCounter() { let count = 1; let total = 2; return { count, total }; }');

      const response = await traceStateTool.handler({
        target_path: root,
        identifier: 'useCounter',
        format: 'json',
      });

      expect(response.isError).toBeUndefined();
      const json = JSON.parse(response.content[0].text);
      expect(json.retrieval).toBeDefined();
      // Must not falsely claim INDEX_CHANGED omission
      const hasIndexChanged = json.retrieval.omissions?.some((o: any) => o.code === 'INDEX_CHANGED');
      expect(hasIndexChanged).toBe(false);
      expect(json.retrieval.freshness).not.toBe('stale');
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // BUG-04 & BUG-05: audit_frontend dead-components separates import vs render
  // -------------------------------------------------------------------------
  it('BUG-04 & BUG-05: dead-components identifies import-only components as orphan/unused (FND-02)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bug04-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
      const child = join(root, 'Child.vue');
      const unused = join(root, 'Unused.vue');
      const app = join(root, 'App.vue');

      writeFileSync(child, '<template><div>Child</div></template>');
      writeFileSync(unused, '<template><div>Unused</div></template>');
      // App imports both Child and Unused, but ONLY renders Child
      writeFileSync(app, `
<script setup>
import Child from './Child.vue';
import Unused from './Unused.vue';
</script>
<template>
  <Child />
</template>
      `);

      getWorkspaceDatabase(root, { create: true });
      await syncWorkspace(root);

      const auditResponse = await auditFrontendTool.handler({
        target_path: root,
        target: 'dead-components',
        include_pages: false,
        output_format: 'json',
      });

      expect(auditResponse.isError).toBeUndefined();
      const json = JSON.parse(auditResponse.content[0].text);
      const orphanNames = json.orphanComponents.map((c: any) => c.name);

      // Unused MUST be reported as orphan component
      expect(orphanNames).toContain('Unused');
      // Child MUST NOT be reported as orphan component (it is rendered)
      expect(orphanNames).not.toContain('Child');
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // BUG-06: generate_patch_plan candidateCount accounting invariant
  // -------------------------------------------------------------------------
  it('BUG-06: strictly preserves candidateCount = analyzedCount + failedCount + unsupportedCount', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-bug06-'));
    try {
      const targetComp = join(root, 'Badge.vue');
      const consumer = join(root, 'Card.vue');

      writeFileSync(targetComp, '<script setup>defineProps<{ text: string }>()</script><template><div>{{ text }}</div></template>');
      writeFileSync(consumer, '<script setup>import Badge from "./Badge.vue"</script><template><Badge text="VIP" /></template>');

      const plan = await generatePatchPlan({
        componentPath: targetComp,
        refactorType: 'rename_prop',
        oldName: 'text',
        newName: 'label',
        targetPath: root,
      });

      const { candidateCount, analyzedCount, failedCount, unsupportedCount, analyzedWithPatchCount, analyzedWithoutPatchCount } = plan.coverage;

      // Mathematical accounting invariant must hold exactly
      expect(candidateCount).toBe(analyzedCount + failedCount + unsupportedCount);
      expect(analyzedCount).toBe(analyzedWithPatchCount + analyzedWithoutPatchCount);
      expect(plan.totalPatches).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // WARN-03: A11y input-label pairing & WCAG 44px touch target preservation
  // -------------------------------------------------------------------------
  it('WARN-03: flags inputs without associated labels and preserves WCAG 44px touch targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-warn03-'));
    try {
      // Input with ID but NO matching label
      writeFileSync(join(root, 'NoLabel.vue'), `
<template>
  <div>
    <input id="unlabeled-input" type="text" />
  </div>
</template>
      `);

      // Input with ID AND matching label
      writeFileSync(join(root, 'WithLabel.vue'), `
<template>
  <div>
    <label for="labeled-input">Username</label>
    <input id="labeled-input" type="text" />
  </div>
</template>
      `);

      // legitimate WCAG touch target vs arbitrary size
      writeFileSync(join(root, 'TouchTarget.vue'), `
<template>
  <button class="min-h-[44px] min-w-[44px]">Accessible Touch</button>
  <div class="min-h-[53px] w-[19px]">Arbitrary Dimension</div>
</template>
      `);

      const audit = await auditDesignTokens({ targetPath: root });

      // 1. A11y: NoLabel.vue must be flagged
      const unlabeledViolation = audit.a11yViolations.find(v => v.file.includes('NoLabel.vue'));
      expect(unlabeledViolation).toBeDefined();
      expect(unlabeledViolation?.issue).toContain('unlabeled-input');

      // 2. A11y: WithLabel.vue must NOT be flagged
      const withLabelViolation = audit.a11yViolations.find(v => v.file.includes('WithLabel.vue'));
      expect(withLabelViolation).toBeUndefined();

      // 3. Design Tokens: min-h-[44px] and min-w-[44px] must NOT be flagged
      const tokens = audit.arbitraryTokens.map(t => t.token);
      expect(tokens.some(t => t.includes('min-h-[44px]'))).toBe(false);
      expect(tokens.some(t => t.includes('min-w-[44px]'))).toBe(false);

      // 4. Design Tokens: arbitrary dimensions like min-h-[53px] MUST be flagged
      expect(tokens.some(t => t.includes('min-h-[53px]'))).toBe(true);
      expect(tokens.some(t => t.includes('w-[19px]'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // WARN-01: formatMatchesAsText distinguishes [import] vs [render] labels
  // -------------------------------------------------------------------------
  it('WARN-01: findComponentUsage labels import and render usages distinctly in formatted text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-warn01-'));
    try {
      writeFileSync(join(root, 'Button.vue'), '<template><button><slot /></button></template>');
      writeFileSync(
        join(root, 'Consumer.vue'),
        `<script setup lang="ts">
import Button from './Button.vue';
</script>
<template>
  <Button>Click Me</Button>
</template>`
      );

      const matches = await findComponentUsage({
        targetPath: root,
        componentName: 'Button',
        scope: 'both',
      });

      expect(matches.length).toBeGreaterThanOrEqual(2);
      const importMatch = matches.find(m => m.usageKind === 'import');
      const renderMatch = matches.find(m => m.usageKind === 'render');

      expect(importMatch).toBeDefined();
      expect(renderMatch).toBeDefined();

      const formatted = formatMatchesAsText(matches);
      expect(formatted).toContain('[import]');
      expect(formatted).toContain('[render]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // WARN-02: extractVueContract resolves external types imported via alias path
  // -------------------------------------------------------------------------
  it('WARN-02: extractVueContract resolves external types imported via alias path (@/...)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-warn02-'));
    try {
      mkdirSync(join(root, 'src', 'types'), { recursive: true });
      mkdirSync(join(root, 'src', 'components'), { recursive: true });

      // tsconfig with paths alias
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
            },
          },
        })
      );

      // External type file
      writeFileSync(
        join(root, 'src', 'types', 'user.ts'),
        `export interface UserProps {
  name: string;
  age?: number;
}`
      );

      // Component importing type via alias
      const compPath = join(root, 'src', 'components', 'UserProfile.vue');
      const compCode = `<script setup lang="ts">
import type { UserProps } from '@/types/user';
defineProps<UserProps>();
</script>
<template><div>{{ name }}</div></template>`;
      writeFileSync(compPath, compCode);

      const contract = await extractVueContract(compPath, compCode, { workspaceRoot: root });

      expect(contract.props.length).toBe(2);
      const nameProp = contract.props.find(p => p.name === 'name');
      const ageProp = contract.props.find(p => p.name === 'age');

      expect(nameProp).toBeDefined();
      expect(nameProp?.required).toBe(true);
      expect(ageProp).toBeDefined();
      expect(ageProp?.required).toBe(false);

      expect(contract.unresolvedTypes).toBeUndefined();
      expect(contract.dependencies.length).toBeGreaterThan(0);
      expect(contract.dependencies[0].path).toContain('user.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
