import { describe, expect, it } from 'bun:test';
import { parseSfc } from '../../src/engine/splitter';
import { remapMatch, remapPosition } from '../../src/engine/remapper';
import type { RawMatch } from '../../src/types';

describe('Offset Remapper (Task 4 DoD)', () => {
  it('correctly remaps position on the first line of a block', () => {
    // Block starts at line 5, column 9
    const blockStart = { line: 5, column: 9, offset: 50 };

    // Relative match is line 1, column 3 inside block
    const pos = remapPosition(1, 3, blockStart);

    expect(pos.line).toBe(5);
    expect(pos.column).toBe(11); // 9 + 3 - 1
  });

  it('correctly remaps position on subsequent lines of a block', () => {
    // Block starts at line 5, column 9
    const blockStart = { line: 5, column: 9, offset: 50 };

    // Relative match is line 3, column 4 inside block
    const pos = remapPosition(3, 4, blockStart);

    expect(pos.line).toBe(7); // 5 + 3 - 1 = 7
    expect(pos.column).toBe(4);
  });

  it('End-to-End: accurately identifies exact file line in real .vue source', () => {
    const rawVue = `<template>
  <div class="container">
    <OldButton label="Submit" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import OldButton from '@/components/OldButton.vue';

const count = ref(0);
console.log(count.value);
</script>`;

    const sfc = parseSfc(rawVue, 'TestComponent.vue');
    const scriptBlock = sfc.scriptSetup!;

    // In rawVue:
    // Line 7: <script setup lang="ts">
    // Line 8: import { ref } from 'vue';
    // Line 9: import OldButton from '@/components/OldButton.vue';
    // Line 10:
    // Line 11: const count = ref(0);
    // Line 12: console.log(count.value);

    // Suppose ast-grep finds `console.log(count.value)`
    // Inside script block content:
    // Line 1 is empty or newline
    // Line 6 of block content is `console.log(count.value);`
    const rawLines = scriptBlock.content.split('\n');
    const targetIdx = rawLines.findIndex((l) => l.includes('console.log'));
    const relativeLine = targetIdx + 1; // 1-indexed

    const rawMatch: RawMatch = {
      line: relativeLine,
      column: 1,
      text: 'console.log(count.value);',
    };

    const resolved = remapMatch(rawMatch, scriptBlock, 'TestComponent.vue');

    // The line in the full file should match line 12
    expect(resolved.line).toBe(12);

    const fullFileLines = rawVue.split('\n');
    expect(fullFileLines[resolved.line - 1]).toContain('console.log(count.value);');
  });
});
