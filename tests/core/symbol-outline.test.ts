import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearTsConfigCache, extractComponentOutline, formatOutlineAsText } from '../../src/engine/outline';
import { sliceSymbol } from '../../src/engine/slicer';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/database';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';

describe('extractComponentOutline', () => {
  let tmpDir: string;
  let samplePath: string;

  beforeEach(() => {
    clearTsConfigCache();
  });

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-outline-'));
    samplePath = path.join(tmpDir, 'OutlineSample.vue');
    const barrelPath = path.join(tmpDir, 'Barrel.ts');

    fs.writeFileSync(
      barrelPath,
      'export function formatCurrency(n: number): string { return "$" + n; }'
    );

    const sfc = `<template>
  <div>
    <button @click="handleClick">{{ count }}</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { formatCurrency } from './Barrel';

const count = ref(0);

const formattedCount = computed(() => {
  return formatCurrency(count.value);
});

function handleClick() {
  count.value++;
  formatCurrency(count.value);
}

const resetCount = (val: number = 0) => {
  count.value = val;
};
</script>
`;
    fs.writeFileSync(samplePath, sfc);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts functions, computed, and arrow functions with exact line bounds from a Vue SFC', async () => {
    const outline = await extractComponentOutline(samplePath, {
      maxFunctionLines: 300,
      resolveCalls: true,
    });

    expect(outline).toBeDefined();
    expect(outline.framework).toBe('vue');
    expect(outline.functions.length).toBeGreaterThanOrEqual(3);

    const clickFn = outline.functions.find((f) => f.name === 'handleClick');
    expect(clickFn).toBeDefined();
    expect(clickFn?.kind).toBe('function');
    expect(clickFn?.startLine).toBeGreaterThan(0);
    expect(clickFn?.endLine).toBeGreaterThanOrEqual(clickFn?.startLine!);
    expect(clickFn?.lineCount).toBeGreaterThanOrEqual(1);

    const computedProp = outline.functions.find((f) => f.name === 'formattedCount');
    expect(computedProp).toBeDefined();
    expect(computedProp?.kind).toBe('computed');

    const arrowFn = outline.functions.find((f) => f.name === 'resetCount');
    expect(arrowFn).toBeDefined();
    expect(arrowFn?.kind).toBe('arrow-function');
  });

  it('flags high-complexity smell when function exceeds line threshold', async () => {
    const outline = await extractComponentOutline(samplePath, {
      maxFunctionLines: 1,
    });

    const clickFn = outline.functions.find((f) => f.name === 'handleClick');
    expect(clickFn?.complexitySmell).toBeDefined();
    expect(clickFn?.complexitySmell?.isHighComplexity).toBe(true);
    expect(clickFn?.complexitySmell?.warning).toContain('exceeds 1-line threshold');
    expect(outline.highComplexityCount).toBeGreaterThanOrEqual(1);
  });

  it('formats outline into markdown table with line ranges', async () => {
    const outline = await extractComponentOutline(samplePath, {
      maxFunctionLines: 300,
    });

    const text = formatOutlineAsText(outline);
    expect(text).toContain('Component Symbol Outline');
    expect(text).toContain('| Function / Symbol | Kind | Range | Lines |');
    expect(text).toContain('handleClick');
  });

  it('resolves 1-hop cross-file callee line coordinates from direct imports', async () => {
    const outline = await extractComponentOutline(samplePath, {
      maxFunctionLines: 300,
      resolveCalls: true,
    });

    const clickFn = outline.functions.find((f) => f.name === 'handleClick');
    expect(clickFn?.resolvedCalls).toBeDefined();
    expect(clickFn?.resolvedCalls?.length).toBeGreaterThanOrEqual(1);

    const formatCall = clickFn?.resolvedCalls?.find((c) => c.symbol === 'formatCurrency');
    expect(formatCall).toBeDefined();
    expect(formatCall?.isResolved).toBe(true);
    expect(formatCall?.targetRange).toBeDefined();
    expect(formatCall?.targetRange?.startLine).toBe(1);
    expect(formatCall?.targetRange?.endLine).toBeGreaterThanOrEqual(1);
  });

  it('resolves barrel re-export chains across multiple files', async () => {
    const actualHelper = path.join(tmpDir, 'ActualHelper.ts');
    const barrelReExport = path.join(tmpDir, 'BarrelReExport.ts');
    const consumerVue = path.join(tmpDir, 'BarrelConsumer.vue');

    fs.writeFileSync(
      actualHelper,
      '// Line 1\n// Line 2\nexport function calculateTax(amount: number): number {\n  return amount * 0.1;\n}\n'
    );

    fs.writeFileSync(
      barrelReExport,
      'export { calculateTax } from "./ActualHelper";\n'
    );

    fs.writeFileSync(
      consumerVue,
      `<script setup lang="ts">
import { calculateTax } from './BarrelReExport';

function handleTax() {
  const tax = calculateTax(100);
}
</script>`
    );

    const outline = await extractComponentOutline(consumerVue, {
      resolveCalls: true,
      workspaceRoot: tmpDir,
    });

    const taxFn = outline.functions.find((f) => f.name === 'handleTax');
    expect(taxFn?.resolvedCalls).toBeDefined();
    const call = taxFn?.resolvedCalls?.find((c) => c.symbol === 'calculateTax');
    expect(call).toBeDefined();
    expect(call?.isResolved).toBe(true);
    expect(call?.targetFilePath).toBe(actualHelper);
    expect(call?.targetRange?.startLine).toBe(3);
    expect(call?.targetRange?.endLine).toBe(5);
  });

  it('resolves namespace member calls (import * as ns)', async () => {
    const actualNsHelper = path.join(tmpDir, 'NsHelper.ts');
    const nsConsumerVue = path.join(tmpDir, 'NsConsumer.vue');

    fs.writeFileSync(
      actualNsHelper,
      'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
    );

    fs.writeFileSync(
      nsConsumerVue,
      `<script setup lang="ts">
import * as mathUtils from './NsHelper';

function compute() {
  return mathUtils.multiply(2, 3);
}
</script>`
    );

    const outline = await extractComponentOutline(nsConsumerVue, {
      resolveCalls: true,
      workspaceRoot: tmpDir,
    });

    const computeFn = outline.functions.find((f) => f.name === 'compute');
    expect(computeFn?.resolvedCalls).toBeDefined();
    const call = computeFn?.resolvedCalls?.find((c) => c.symbol === 'mathUtils.multiply');
    expect(call).toBeDefined();
    expect(call?.isResolved).toBe(true);
    expect(call?.targetRange?.startLine).toBe(1);
  });

  it('resolves tsconfig compilerOptions.paths aliases', async () => {
    const utilsDir = path.join(tmpDir, 'custom_utils');
    fs.mkdirSync(utilsDir, { recursive: true });
    const mathFile = path.join(utilsDir, 'math.ts');
    fs.writeFileSync(mathFile, 'export function add(a: number, b: number) { return a + b; }\n');

    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@custom/*': ['./custom_utils/*'],
          },
        },
      })
    );

    const aliasConsumer = path.join(tmpDir, 'AliasConsumer.vue');
    fs.writeFileSync(
      aliasConsumer,
      `<script setup lang="ts">
import { add } from '@custom/math';

function doAdd() {
  return add(1, 2);
}
</script>`
    );

    const outline = await extractComponentOutline(aliasConsumer, {
      resolveCalls: true,
      workspaceRoot: tmpDir,
    });

    const addFn = outline.functions.find((f) => f.name === 'doAdd');
    expect(addFn?.resolvedCalls).toBeDefined();
    const call = addFn?.resolvedCalls?.find((c) => c.symbol === 'add');
    expect(call?.isResolved).toBe(true);
    expect(call?.targetFilePath).toBe(mathFile);
    expect(call?.targetRange?.startLine).toBe(1);
  });

  it('Workstream 1: excludes unrelated callers and resolves cross-file callees with exact line bounds', async () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ws1-test-'));
    try {
      const serviceFile = path.join(wsDir, 'service.ts');
      const helperFile = path.join(wsDir, 'helper.ts');
      const callerA = path.join(wsDir, 'CallerTarget.vue');
      const callerB = path.join(wsDir, 'CallerOther.vue');

      fs.writeFileSync(
        helperFile,
        'export function computeScore(x: number): number {\n  return x * 10;\n}\n'
      );

      fs.writeFileSync(
        serviceFile,
        `import { computeScore } from './helper';

export function targetFn(val: number) {
  return computeScore(val);
}

export function otherFn(val: number) {
  return val - 1;
}
`
      );

      fs.writeFileSync(
        callerA,
        `<script setup lang="ts">
import { targetFn } from './service';
const res = targetFn(42);
</script>
<template><div>{{ res }}</div></template>`
      );

      fs.writeFileSync(
        callerB,
        `<script setup lang="ts">
import { otherFn } from './service';
const other = otherFn(10);
</script>
<template><div>{{ other }}</div></template>`
      );

      getWorkspaceDatabase(wsDir, { create: true });
      await syncWorkspace(wsDir);

      const slice = await sliceSymbol({
        path: serviceFile,
        symbolName: 'targetFn',
        workspaceRoot: wsDir,
        includeBlastRadius: true,
      });

      expect(slice).not.toBeNull();
      expect(slice?.symbolName).toBe('targetFn');
      expect(slice?.blastRadius).toBeDefined();

      // (a) Caller verification: callerA is confirmed, callerB is NOT confirmed caller
      const confirmedPaths = slice?.blastRadius?.confirmedCallers?.map((c) => c.filePath) || [];
      expect(confirmedPaths).toContain(callerA);
      expect(confirmedPaths).not.toContain(callerB);
      expect(slice?.blastRadius?.status).toBe('resolved');

      // (b) Callee resolution: sliceSymbol returns resolvedCallees across files with line range
      expect(slice?.blastRadius?.resolvedCallees).toBeDefined();
      expect(slice?.blastRadius?.resolvedCallees?.length).toBeGreaterThanOrEqual(1);
      const callee = slice?.blastRadius?.resolvedCallees?.find((c) => c.symbol === 'computeScore');
      expect(callee).toBeDefined();
      expect(callee?.isResolved).toBe(true);
      expect(callee?.targetFilePath).toBe(helperFile);
      expect(callee?.targetRange?.startLine).toBe(1);
      expect(callee?.targetRange?.endLine).toBe(3);
    } finally {
      closeWorkspaceDatabase(wsDir);
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

