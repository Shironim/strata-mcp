import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearTsConfigCache, extractComponentOutline, formatOutlineAsText } from '../../src/engine/outline';

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
});

