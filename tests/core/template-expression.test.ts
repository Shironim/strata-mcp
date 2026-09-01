import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { extractTemplateExpressions } from '../../src/engine/template';
import { findCode, findCodeByRule } from '../../src/engine/search';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Template JS expression scanning', () => {
  it('extracts directive values and interpolations from a template', () => {
    const expressions = extractTemplateExpressions(
      `<button @click="emit('add-laptop')">{{ label }}</button>`
    );

    const contents = expressions.map((e) => e.content);
    expect(contents).toContain("emit('add-laptop')");
    expect(contents).toContain('label');
  });

  it('finds emit(...) calls inside template via findCode', async () => {
    const matches = await findCode({
      pattern: 'emit($$$)',
      targetPath: FIXTURES_DIR,
    });

    const templateMatch = matches.find((m) => m.file.endsWith('TemplateEmit.vue'));
    expect(templateMatch).toBeDefined();
    expect(templateMatch!.blockType).toBe('template');
    expect(templateMatch!.snippet).toContain('emit');
  });

  it('finds emit(...) calls inside template via findCodeByRule', async () => {
    const matches = await findCodeByRule({
      rule: `id: template-emit
language: js
rule:
  pattern: emit($$$)
`,
      targetPath: FIXTURES_DIR,
    });

    const templateMatch = matches.find((m) => m.file.endsWith('TemplateEmit.vue'));
    expect(templateMatch).toBeDefined();
    expect(templateMatch!.blockType).toBe('template');
    expect(templateMatch!.snippet).toContain('emit');
  });

  it('finds interpolations via findCode when batching multiple expressions', async () => {
    const matches = await findCode({
      pattern: 'formatPrice($$$)',
      targetPath: FIXTURES_DIR,
    });

    const interpolationMatch = matches.find((m) => m.file.endsWith('TemplateEmit.vue'));
    expect(interpolationMatch).toBeDefined();
    expect(interpolationMatch!.blockType).toBe('template');
    expect(interpolationMatch!.snippet).toContain('formatPrice');
  });
});
