import { describe, expect, it } from 'bun:test';
import { parseSfc } from '../../src/engine/splitter';
import { findComponentInTemplateBlock, isComponentNameMatch, toKebabCase } from '../../src/engine/template';

describe('Template Matcher (Task 3 DoD)', () => {
  it('converts PascalCase to kebab-case properly', () => {
    expect(toKebabCase('OldButton')).toBe('old-button');
    expect(toKebabCase('UserProfileCard')).toBe('user-profile-card');
  });

  it('matches component names across PascalCase and kebab-case', () => {
    expect(isComponentNameMatch('OldButton', 'OldButton')).toBe(true);
    expect(isComponentNameMatch('old-button', 'OldButton')).toBe(true);
    expect(isComponentNameMatch('OldButton', 'old-button')).toBe(true);
    expect(isComponentNameMatch('NewButton', 'OldButton')).toBe(false);
  });

  it('DoD: finds all component usages in template with accurate line numbers', () => {
    const rawVue = `<template>
  <div class="page">
    <header>
      <OldButton label="Header Action" />
    </header>
    <main>
      <old-button variant="danger" />
      <component :is="'OldButton'" />
      <NewButton />
    </main>
  </div>
</template>

<script setup>
import OldButton from './OldButton.vue';
import NewButton from './NewButton.vue';
</script>`;

    const sfc = parseSfc(rawVue, 'Dashboard.vue');
    expect(sfc.template).not.toBeNull();

    const matches = findComponentInTemplateBlock(sfc.template!, 'OldButton', 'Dashboard.vue');

    // Should find:
    // 1. <OldButton label="Header Action" /> (line 4)
    // 2. <old-button variant="danger" /> (line 7)
    // 3. <component :is="'OldButton'" /> (line 8)
    expect(matches.length).toBe(3);

    const fullLines = rawVue.split('\n');

    expect(matches[0].line).toBe(4);
    expect(fullLines[matches[0].line - 1]).toContain('<OldButton');

    expect(matches[1].line).toBe(7);
    expect(fullLines[matches[1].line - 1]).toContain('<old-button');

    expect(matches[2].line).toBe(8);
    expect(fullLines[matches[2].line - 1]).toContain('<component :is=');
  });
});
