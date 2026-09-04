import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSymbolRuleYaml,
  extractInternalCalls,
  extractSignature,
  formatSymbolSliceAsText,
  inferSymbolKind,
  sliceSymbol,
} from '../../src/engine/slicer';

describe('Precision Symbol Slicer Engine', () => {
  it('infers symbol kinds accurately from code snippets', () => {
    expect(inferSymbolKind('export function calculateTotal() {}')).toBe('function');
    expect(inferSymbolKind('const sum = (a, b) => a + b;')).toBe('arrow-function');
    expect(inferSymbolKind('export class UserService {}')).toBe('class');
    expect(inferSymbolKind('export interface UserDTO {}')).toBe('interface');
    expect(inferSymbolKind('export type Status = "ok" | "err";')).toBe('type');
    expect(inferSymbolKind('const DEFAULT_LIMIT = 50;')).toBe('variable');
  });

  it('extracts signatures cleanly', () => {
    expect(extractSignature('function add(a: number, b: number): number {\n  return a + b;\n}')).toBe(
      'function add(a: number, b: number): number'
    );
    expect(extractSignature('interface User {\n  id: string;\n}')).toBe('interface User');
  });

  it('extracts internal calls from a code slice', () => {
    const code = `
      function submitOrder(order) {
        validateOrder(order);
        const total = calculateTotal(order.items);
        notifyUser('success');
        return total;
      }
    `;
    const calls = extractInternalCalls(code, 'submitOrder');
    expect(calls).toContain('validateOrder');
    expect(calls).toContain('calculateTotal');
    expect(calls).toContain('notifyUser');
    expect(calls).not.toContain('submitOrder');
  });

  it('slices a function from a TypeScript file with exact line numbers', async () => {
    const tempDir = join(tmpdir(), `strata-slicer-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const tsFile = join(tempDir, 'math.ts');

    const content = [
      '// File header comment',
      'export const PI = 3.14;',
      '',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
    ].join('\n');

    await fs.writeFile(tsFile, content, 'utf8');

    const result = await sliceSymbol({
      path: tsFile,
      symbolName: 'add',
      includeBlastRadius: false,
    });

    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe('add');
    expect(result!.kind).toBe('function');
    expect(result!.startLine).toBe(4);
    expect(result!.endLine).toBe(6);
    expect(result!.code).toContain('4: export function add');
    expect(result!.code).toContain('5:   return a + b;');
    expect(result!.code).toContain('6: }');

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('slices a symbol from a Vue SFC <script setup> with exact line remapping', async () => {
    const tempDir = join(tmpdir(), `strata-slicer-vue-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const vueFile = join(tempDir, 'Counter.vue');

    const content = [
      '<template>',
      '  <div>',
      '    <p>{{ count }}</p>',
      '    <button @click="increment">+1</button>',
      '  </div>',
      '</template>',
      '',
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      '',
      'const count = ref(0);',
      '',
      'function increment() {',
      '  count.value++;',
      '}',
      '</script>',
    ].join('\n');

    await fs.writeFile(vueFile, content, 'utf8');

    const result = await sliceSymbol({
      path: vueFile,
      symbolName: 'increment',
      includeBlastRadius: false,
    });

    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe('increment');
    expect(result!.kind).toBe('function');
    // In the file above:
    // line 13 is 'function increment() {'
    // line 14 is '  count.value++;'
    // line 15 is '}'
    expect(result!.startLine).toBe(13);
    expect(result!.endLine).toBe(15);
    expect(result!.code).toContain('13: function increment() {');
    expect(result!.code).toContain('14:   count.value++;');
    expect(result!.code).toContain('15: }');

    const formatted = formatSymbolSliceAsText(result!);
    expect(formatted).toContain('### Symbol: `increment` (function)');
    expect(formatted).toContain(':13-15');

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
