import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractPatternKeywords,
  extractRuleKeywords,
  findCode,
  findComponentUsage,
  formatMatchesAsText,
} from '../../src/engine/search';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Core Search & Audit (Section 8 End-to-End Success Criteria)', () => {
  it('finds all usages of OldButton across both .vue and .tsx files', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    expect(matches.length).toBeGreaterThanOrEqual(4);

    const files = matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith('PageOne.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('PageTwo.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('PageThree.vue'))).toBe(false);

    // Verify PageOne.vue template usage is identified with accurate line
    const pageOneTemplateMatch = matches.find(
      (m) => m.file.endsWith('PageOne.vue') && m.blockType === 'template'
    );
    expect(pageOneTemplateMatch).toBeDefined();
    expect(pageOneTemplateMatch!.line).toBe(4);
    expect(pageOneTemplateMatch!.snippet).toContain('<OldButton');

    // Verify PageOne.vue script import is identified with accurate line
    const pageOneScriptMatch = matches.find(
      (m) => m.file.endsWith('PageOne.vue') && m.blockType === 'scriptSetup'
    );
    expect(pageOneScriptMatch).toBeDefined();
    expect(pageOneScriptMatch!.line).toBe(9);
    expect(pageOneScriptMatch!.snippet).toContain('import OldButton');
  });

  it('finds all usages of NewButton across both .vue and .tsx files', async () => {
    const matches = await findComponentUsage({
      componentName: 'NewButton',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    const files = matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith('PageOne.vue'))).toBe(false);
    expect(files.some((f) => f.endsWith('PageTwo.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('PageThree.vue'))).toBe(true);
  });

  it('searches structural patterns inside Vue script blocks using ast-grep', async () => {
    const matches = await findCode({
      pattern: 'defineProps<$$$>()',
      targetPath: FIXTURES_DIR,
    });

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const newButtonMatch = matches.find((m) => m.file.endsWith('NewButton.vue'));
    expect(newButtonMatch).toBeDefined();
    expect(newButtonMatch!.blockType).toBe('scriptSetup');
    expect(newButtonMatch!.line).toBe(6);
  });

  it('formats matches into token-efficient, single-line snippets', () => {
    const formatted = formatMatchesAsText([
      {
        file: 'src/views/Home.vue',
        line: 12,
        column: 5,
        blockType: 'template',
        snippet: '<OldButton label="Submit" />',
      },
    ]);

    expect(formatted).toBe('src/views/Home.vue:12:5 - <OldButton label="Submit" />');
  });

  it('searches template HTML tags in Vue SFC via findCode with line remapping (GAP-04)', async () => {
    const matches = await findCode({
      pattern: '<OldButton>$$$</OldButton>',
      targetPath: FIXTURES_DIR,
    });

    const pageOneMatch = matches.find(
      (m) => m.file.endsWith('PageOne.vue') && m.blockType === 'template'
    );
    expect(pageOneMatch).toBeDefined();
    expect(pageOneMatch!.line).toBe(4);
    expect(pageOneMatch!.snippet).toContain('<OldButton>Click Me</OldButton>');
  });

  it('finds component usages uniformly using kebab-case across Vue and JSX (GAP-01)', async () => {
    const matches = await findComponentUsage({
      componentName: 'old-button',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    // Should find Vue template and script in PageOne.vue
    expect(matches.some((m) => m.file.endsWith('PageOne.vue'))).toBe(true);
    // Should find TSX JSX usage and imports in PageTwo.tsx
    expect(matches.some((m) => m.file.endsWith('PageTwo.tsx'))).toBe(true);
    // Should find JSX namespace usage in NamespacePage.tsx
    const namespaceMatch = matches.find((m) => m.file.endsWith('NamespacePage.tsx') && m.snippet.includes('<UI.OldButton'));
    expect(namespaceMatch).toBeDefined();
    expect(namespaceMatch!.snippet).toContain('<UI.OldButton');
  });

  it('extracts non-metavariable literal keywords for Fast-Path Pruning (Engine B)', () => {
    expect(extractPatternKeywords('ref($$$)')).toEqual(['ref']);
    expect(extractPatternKeywords('ref<$$$>($$$)')).toEqual(['ref']);
    expect(extractPatternKeywords('<ProductCard $$$/>')).toEqual(['ProductCard']);
    expect(extractPatternKeywords('const $NAME = ref($VAL)')).toEqual(['const', 'ref']);
    expect(extractPatternKeywords('$$$')).toEqual([]);

    const ruleKeywords = extractRuleKeywords(`
id: test
language: ts
rule:
  pattern: defineAsyncComponent($$$)
`);
    expect(ruleKeywords).toContain('defineAsyncComponent');
  });

  it('prunes non-matching files instantly on nonexistent component search (Engine B)', async () => {
    const matches = await findComponentUsage({
      componentName: 'NonExistentComponentXYZ',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });
    expect(matches).toEqual([]);
  });
});
