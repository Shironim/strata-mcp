import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { findComponentUsage, formatMatchesAsText } from '../../src/engine/search';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Advanced Imports & Astro Islands (Feature Brief)', () => {
  it('detects Vue & React components in Astro Islands with client directives', async () => {
    // 1. Audit VueCounter inside Astro
    const vueMatches = await findComponentUsage({
      componentName: 'VueCounter',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    const astroVueMatch = vueMatches.find(
      (m) => m.file.endsWith('AstroIsland.astro') && m.blockType === 'astroTemplate'
    );
    expect(astroVueMatch).toBeDefined();
    expect(astroVueMatch!.line).toBe(9);
    expect(astroVueMatch!.snippet).toContain('<VueCounter client:visible');
    expect(astroVueMatch!.clientDirective).toBe('client:visible');

    // 2. Audit ReactButton inside Astro
    const reactMatches = await findComponentUsage({
      componentName: 'ReactButton',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    const astroReactMatch = reactMatches.find(
      (m) => m.file.endsWith('AstroIsland.astro') && m.blockType === 'astroTemplate'
    );
    expect(astroReactMatch).toBeDefined();
    expect(astroReactMatch!.line).toBe(10);
    expect(astroReactMatch!.clientDirective).toBe('client:load');

    // 3. Formatted output includes directive token
    const formatted = formatMatchesAsText([astroVueMatch!]);
    expect(formatted).toContain('[client:visible]');
  });

  it('detects dynamic / lazy imports in Vue (defineAsyncComponent) and React (React.lazy)', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'script',
    });

    // Check Vue defineAsyncComponent
    const asyncPageMatch = matches.find((m) => m.file.endsWith('AsyncPage.vue'));
    expect(asyncPageMatch).toBeDefined();
    expect(asyncPageMatch!.snippet).toContain('defineAsyncComponent');

    // Check React.lazy
    const dynamicPageMatch = matches.find((m) => m.file.endsWith('DynamicPage.tsx'));
    expect(dynamicPageMatch).toBeDefined();
    expect(dynamicPageMatch!.snippet).toContain('React.lazy');
  });

  it('detects barrel file re-exports (export { default as X })', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'script',
    });

    const barrelMatch = matches.find((m) => m.file.endsWith('Barrel.ts'));
    expect(barrelMatch).toBeDefined();
    expect(barrelMatch!.snippet).toContain('export { default as OldButton }');
  });

  it('detects aliased imports and links template usage (<LegacyBtn /> -> OldButton)', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'both',
    });

    // Template usage of <LegacyBtn /> in AliasedPage.vue should be detected
    const aliasedTemplateMatch = matches.find(
      (m) => m.file.endsWith('AliasedPage.vue') && m.blockType === 'template'
    );
    expect(aliasedTemplateMatch).toBeDefined();
    expect(aliasedTemplateMatch!.snippet).toContain('<LegacyBtn');
  });

  it('detects namespace component usage (<UI.OldButton /> in JSX)', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'template',
    });

    const namespaceMatch = matches.find((m) => m.file.endsWith('NamespacePage.tsx'));
    expect(namespaceMatch).toBeDefined();
    expect(namespaceMatch!.snippet).toContain('<UI.OldButton');
  });

  it('detects aliased imports in template when scope is strictly template (GAP-07)', async () => {
    const matches = await findComponentUsage({
      componentName: 'OldButton',
      targetPath: FIXTURES_DIR,
      scope: 'template',
    });

    // Template usage of <LegacyBtn /> in AliasedPage.vue should be detected
    const aliasedTemplateMatch = matches.find(
      (m) => m.file.endsWith('AliasedPage.vue') && m.blockType === 'template'
    );
    expect(aliasedTemplateMatch).toBeDefined();
    expect(aliasedTemplateMatch!.snippet).toContain('<LegacyBtn');

    // Ensure script imports are excluded when scope is strictly template
    const aliasedScriptMatch = matches.find(
      (m) => m.file.endsWith('AliasedPage.vue') && m.blockType === 'scriptSetup'
    );
    expect(aliasedScriptMatch).toBeUndefined();
  });
});
