import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  findUnusedComponents,
  formatUnusedAsText,
  matchesGlob,
} from '../../src/engine/audit';
import { createMcpServer } from '../../src/mcp';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');
const VUE_APP_DIR = join(import.meta.dir, '../mock-projects/vue-app');

describe('Unused Components Audit Engine (Phase 4 RFC)', () => {
  it('evaluates glob patterns accurately with matchesGlob', () => {
    expect(matchesGlob('src/pages/Home.vue', '**/pages/**')).toBe(true);
    expect(matchesGlob('resources/js/Pages/Auth/ForgotPassword.vue', '**/pages/**')).toBe(true);
    expect(matchesGlob('src/views/CatalogView.vue', '**/views/**')).toBe(true);
    expect(matchesGlob('src/components/Card.stories.tsx', '**/*.stories.*')).toBe(true);
    expect(matchesGlob('src/components/Card.test.ts', '**/*.test.*')).toBe(true);
    expect(matchesGlob('src/components/ProductCard.vue', '**/*.stories.*')).toBe(false);
    expect(matchesGlob('src/audit.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/engine/audit.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('audit.ts', '**/*.ts')).toBe(true);
  });

  it('audits fixtures directory and detects unreferenced CardComponent.tsx', async () => {
    const result = await findUnusedComponents({
      targetPath: FIXTURES_DIR,
      ignorePatterns: [
        'Page*.vue',
        'Page*.tsx',
        'AutoImport*.vue',
        'AsyncPage.vue',
        'AliasedPage.vue',
        'DynamicPage.tsx',
        'NamespacePage.tsx',
        'AstroIsland.astro',
        'RuntimePropsButton.vue',
        'TemplateEmit.vue',
        'AliasTreeRoot.vue',
        'AliasOverrideRoot.vue',
      ],
    });

    expect(result.totalScanned).toBeGreaterThanOrEqual(4);
    expect(result.unusedCount).toBe(1);
    expect(result.unusedComponents[0].name).toBe('CardComponent');
    expect(result.unusedComponents[0].framework).toBe('react');
  });

  it('audits enterprise vue-app project confirming all components are actively used', async () => {
    const result = await findUnusedComponents({
      targetPath: VUE_APP_DIR,
    });

    expect(result.totalScanned).toBe(5);
    expect(result.unusedCount).toBe(0);
    expect(result.unusedComponents).toEqual([]);
  });

  it('formats unused components results into clean readable text', async () => {
    const result = await findUnusedComponents({
      targetPath: FIXTURES_DIR,
      ignorePatterns: [
        'Page*.vue',
        'Page*.tsx',
        'AsyncPage.vue',
        'AliasedPage.vue',
        'DynamicPage.tsx',
        'NamespacePage.tsx',
        'AstroIsland.astro',
        'RuntimePropsButton.vue',
        'TemplateEmit.vue',
        'AliasTreeRoot.vue',
        'AliasOverrideRoot.vue',
      ],
    });

    const text = formatUnusedAsText(result);
    expect(text).toContain('Unused Components Audit');
    expect(text).toContain('Total Components Scanned:');
    expect(text).toContain('CardComponent.tsx (react)');
  });

  it('invokes audit_frontend (dead-components) via MCP call tool handler', async () => {
    const server = createMcpServer();
    const handlers = (server as any)._requestHandlers;
    const callHandler = handlers.get('tools/call');

    const res = await callHandler({
      method: 'tools/call',
      params: {
        name: 'audit_frontend',
        arguments: {
          target: 'dead-components',
          target_path: VUE_APP_DIR,
          output_format: 'json',
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.totalScanned).toBe(5);
    expect(parsed.unusedCount).toBe(0);
  });
});
