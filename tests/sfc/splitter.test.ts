import { describe, expect, it } from 'bun:test';
import { parseSfc, getAllScriptBlocks } from '../../src/engine/splitter';

describe('SFC Splitter (Task 1 DoD)', () => {
  it('1. Options API SFC with template, script, and style', () => {
    const raw = `<template>
  <div class="card">
    <h1>{{ title }}</h1>
  </div>
</template>

<script>
export default {
  data() {
    return {
      title: 'Hello Vue'
    }
  }
}
</script>

<style>
.card {
  padding: 1rem;
}
</style>`;

    const sfc = parseSfc(raw, 'OptionsApi.vue');

    expect(sfc.template).not.toBeNull();
    expect(sfc.script).not.toBeNull();
    expect(sfc.scriptSetup).toBeNull();
    expect(sfc.styles.length).toBe(1);

    // Reconstruct substring verification
    const templateSubstring = raw.slice(sfc.template!.loc.start.offset, sfc.template!.loc.end.offset);
    expect(templateSubstring).toBe(sfc.template!.content);

    const scriptSubstring = raw.slice(sfc.script!.loc.start.offset, sfc.script!.loc.end.offset);
    expect(scriptSubstring).toBe(sfc.script!.content);

    const styleSubstring = raw.slice(sfc.styles[0].loc.start.offset, sfc.styles[0].loc.end.offset);
    expect(styleSubstring).toBe(sfc.styles[0].content);
  });

  it('2. Composition API SFC with <script setup>', () => {
    const raw = `<template>
  <button @click="count++">Count: {{ count }}</button>
</template>

<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<style scoped>
button {
  background: blue;
}
</style>`;

    const sfc = parseSfc(raw, 'CompositionApi.vue');

    expect(sfc.template).not.toBeNull();
    expect(sfc.script).toBeNull();
    expect(sfc.scriptSetup).not.toBeNull();
    expect(sfc.scriptSetup!.lang).toBe('js');

    // Reconstruct substring verification
    const scriptSetupSubstring = raw.slice(
      sfc.scriptSetup!.loc.start.offset,
      sfc.scriptSetup!.loc.end.offset
    );
    expect(scriptSetupSubstring).toBe(sfc.scriptSetup!.content);

    const scriptBlocks = getAllScriptBlocks(sfc);
    expect(scriptBlocks.length).toBe(1);
    expect(scriptBlocks[0].type).toBe('scriptSetup');
  });

  it('3. TypeScript SFC with <script setup lang="ts">', () => {
    const raw = `<script setup lang="ts">
interface UserProps {
  id: number;
  name: string;
}
defineProps<UserProps>();
</script>

<template>
  <span>{{ name }}</span>
</template>`;

    const sfc = parseSfc(raw, 'TypeScriptComponent.vue');

    expect(sfc.scriptSetup).not.toBeNull();
    expect(sfc.scriptSetup!.lang).toBe('ts');

    // Reconstruct substring verification
    const scriptSubstring = raw.slice(
      sfc.scriptSetup!.loc.start.offset,
      sfc.scriptSetup!.loc.end.offset
    );
    expect(scriptSubstring).toBe(sfc.scriptSetup!.content);

    expect(sfc.template).not.toBeNull();
    const templateSubstring = raw.slice(sfc.template!.loc.start.offset, sfc.template!.loc.end.offset);
    expect(templateSubstring).toBe(sfc.template!.content);
  });

  it('4. Template-only SFC without script blocks', () => {
    const raw = `<template>
  <svg viewBox="0 0 24 24">
    <path d="M12 2L2 22h20L12 2z" />
  </svg>
</template>

<style scoped>
svg {
  fill: currentColor;
}
</style>`;

    const sfc = parseSfc(raw, 'IconLogo.vue');

    expect(sfc.template).not.toBeNull();
    expect(sfc.script).toBeNull();
    expect(sfc.scriptSetup).toBeNull();
    expect(getAllScriptBlocks(sfc).length).toBe(0);

    const templateSubstring = raw.slice(sfc.template!.loc.start.offset, sfc.template!.loc.end.offset);
    expect(templateSubstring).toBe(sfc.template!.content);
  });

  it('5. SFC with multiple style blocks (scoped and unscoped scss/css)', () => {
    const raw = `<template>
  <div class="styled-box">Multi-style</div>
</template>

<style>
.styled-box {
  display: flex;
}
</style>

<style scoped lang="scss">
.styled-box {
  color: red;
}
</style>`;

    const sfc = parseSfc(raw, 'MultiStyle.vue');

    expect(sfc.styles.length).toBe(2);
    expect(sfc.styles[0].scoped).toBe(false);
    expect(sfc.styles[0].lang).toBe('css');
    expect(sfc.styles[1].scoped).toBe(true);
    expect(sfc.styles[1].lang).toBe('scss');

    // Reconstruct substring verification for each style block
    for (const style of sfc.styles) {
      const styleSubstring = raw.slice(style.loc.start.offset, style.loc.end.offset);
      expect(styleSubstring).toBe(style.content);
    }
  });

  it('6. Edge Case: Both regular <script> and <script setup> in one SFC', () => {
    const raw = `<script>
export default {
  inheritAttrs: false,
};
</script>

<script setup lang="ts">
import { ref } from 'vue';
const ready = ref(true);
</script>

<template>
  <div>Dual Script Test</div>
</template>`;

    const sfc = parseSfc(raw, 'DualScript.vue');

    expect(sfc.script).not.toBeNull();
    expect(sfc.scriptSetup).not.toBeNull();

    // Verify both scripts have distinct non-overlapping locations
    expect(sfc.script!.loc.start.offset).toBeLessThan(sfc.scriptSetup!.loc.start.offset);

    const scriptSubstring = raw.slice(sfc.script!.loc.start.offset, sfc.script!.loc.end.offset);
    expect(scriptSubstring).toBe(sfc.script!.content);

    const scriptSetupSubstring = raw.slice(
      sfc.scriptSetup!.loc.start.offset,
      sfc.scriptSetup!.loc.end.offset
    );
    expect(scriptSetupSubstring).toBe(sfc.scriptSetup!.content);

    const allScripts = getAllScriptBlocks(sfc);
    expect(allScripts.length).toBe(2);
  });
});
