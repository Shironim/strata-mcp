import { describe, expect, test } from 'bun:test';
import { coerceToolArguments, parseSafePositiveInt, parseSafeFloat } from '../src/mcp';
import { auditFrontendTool } from '../src/tools/audit-frontend';
import { patchPlanTool } from '../src/tools/patch-plan';
import { componentTreeTool } from '../src/tools/component-tree';
import * as StrataIndex from '../src/index';

describe('Strata-MCP Parity, Coercion, & Hardening Suite', () => {
  describe('Safe Numeric Parsers', () => {
    test('parseSafePositiveInt handles valid integers, strings, NaN, and <= 0', () => {
      expect(parseSafePositiveInt(3)).toBe(3);
      expect(parseSafePositiveInt('5')).toBe(5);
      expect(parseSafePositiveInt('invalid', 2)).toBe(2);
      expect(parseSafePositiveInt(NaN, 4)).toBe(4);
      expect(parseSafePositiveInt(0, 1)).toBe(1);
      expect(parseSafePositiveInt(-3, 1)).toBe(1);
      expect(parseSafePositiveInt(undefined, 3)).toBe(3);
    });

    test('parseSafeFloat preserves 0 threshold and rejects NaN', () => {
      expect(parseSafeFloat(0)).toBe(0);
      expect(parseSafeFloat('0')).toBe(0);
      expect(parseSafeFloat('0.75')).toBe(0.75);
      expect(parseSafeFloat('invalid', 0.8)).toBe(0.8);
      expect(parseSafeFloat(-0.5, 0.8)).toBe(0.8);
    });
  });

  describe('Universal MCP Coercion (coerceToolArguments)', () => {
    test('normalizes framework_hint and frameworkHint to framework', () => {
      const a1 = coerceToolArguments('get_routes', { framework_hint: 'nuxt' });
      expect(a1.framework).toBe('nuxt');

      const a2 = coerceToolArguments('audit_frontend', { frameworkHint: 'next-app' });
      expect(a2.framework).toBe('next-app');
    });

    test('normalizes scope_path, scopePath, scope_filter, and scopeFilter bidirectionally', () => {
      const a1 = coerceToolArguments('get_component_tree', { scope_path: 'apps/web' });
      expect(a1.scope_filter).toBe('apps/web');
      expect(a1.scope_path).toBe('apps/web');

      const a2 = coerceToolArguments('audit_frontend', { scopeFilter: 'features/auth' });
      expect(a2.scope_path).toBe('features/auth');
      expect(a2.scope_filter).toBe('features/auth');
    });

    test('normalizes alias_map, aliasMap, and alias (including string and JSON formats)', () => {
      const a1 = coerceToolArguments('get_component_tree', { aliasMap: { '@/': 'src/' } });
      expect(a1.alias_map).toEqual({ '@/': 'src/' });

      const a2 = coerceToolArguments('get_component_tree', { alias: '@/=src/,~components/=src/components/' });
      expect(a2.alias_map).toEqual({ '@/': 'src/', '~components/': 'src/components/' });

      const a3 = coerceToolArguments('get_component_tree', { alias_map: '{"@":"resources/js"}' });
      expect(a3.alias_map).toEqual({ '@': 'resources/js' });
    });

    test('normalizes comma-separated exclude_dirs and ignore_patterns', () => {
      const a1 = coerceToolArguments('audit_frontend', {
        excludeDirs: 'dist, build , coverage',
        ignorePatterns: '*.stories.vue, *.test.vue',
      });
      expect(a1.exclude_dirs).toEqual(['dist', 'build', 'coverage']);
      expect(a1.ignore_patterns).toEqual(['*.stories.vue', '*.test.vue']);
    });

    test('guards depth, max_depth, max_results, and threshold against NaN and 0', () => {
      const bad = coerceToolArguments('get_component_tree', {
        depth: 'not-a-number',
        max_results: 0,
        threshold: 'nan',
      });
      expect(bad.depth).toBeUndefined();
      expect(bad.max_depth).toBeUndefined();
      expect(bad.max_results).toBeUndefined();
      expect(bad.threshold).toBeUndefined();

      const zeroThreshold = coerceToolArguments('audit_frontend', {
        threshold: 0,
        depth: '4',
      });
      expect(zeroThreshold.threshold).toBe(0);
      expect(zeroThreshold.depth).toBe(4);
      expect(zeroThreshold.max_depth).toBe(4);
    });
  });

  describe('Tool Handler Validation & Parity', () => {
    test('audit_frontend rejects unknown targets with isError instead of running all 7 audits', async () => {
      const res = await auditFrontendTool.handler({ target: 'unknown-audit-target' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid audit target');
    });

    test('audit_frontend accepts snake_case target and short aliases without falling through to all', async () => {
      const res = await auditFrontendTool.handler({
        target: 'archetype_drift',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Missing required argument: 'path'");
    });

    test('generate_patch_plan requires new_name for rename_model and rename_slot', async () => {
      const resModel = await patchPlanTool.handler({
        path: 'src/Button.vue',
        refactor_type: 'rename_model',
        old_name: 'modelValue',
      });
      expect(resModel.isError).toBe(true);
      expect(resModel.content[0].text).toContain('"new_name" is required');

      const resSlot = await patchPlanTool.handler({
        path: 'src/Button.vue',
        refactor_type: 'rename_slot',
        old_name: 'header',
      });
      expect(resSlot.isError).toBe(true);
      expect(resSlot.content[0].text).toContain('"new_name" is required');
    });

    test('public library index exports template-similarity, bundle-audit, dynamic-imports, and tools', () => {
      expect(typeof StrataIndex.findSimilarTemplates).toBe('function');
      expect(typeof StrataIndex.auditBundleHealth).toBe('function');
      expect(typeof StrataIndex.scanDynamicImportsAndGlobals).toBe('function');
      expect(Array.isArray(StrataIndex.TOOLS)).toBe(true);
      expect(StrataIndex.TOOLS.length).toBe(8);
    });

    test('strata init templates and instructions include archetype-drift, rename_model, and rename_slot', async () => {
      const { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL } = await import('../src/cli/templates');
      const { STRATA_INSTRUCTIONS } = await import('../src/instructions');

      expect(STRATA_FRONTEND_RULE).toContain('archetype-drift');
      expect(STRATA_FRONTEND_RULE).toContain('rename_model');
      expect(STRATA_FRONTEND_RULE).toContain('rename_slot');

      expect(STRATA_INSPECT_SKILL).toContain('archetype-drift');
      expect(STRATA_INSPECT_SKILL).toContain('rename_model');

      expect(STRATA_INSTRUCTIONS).toContain('archetype-drift');
      expect(STRATA_INSTRUCTIONS).toContain('rename_model');
    });
  });
});

