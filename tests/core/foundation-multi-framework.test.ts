import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFiles, iterateFiles } from '../../src/engine/collector';
import {
  detectFrameworkWithEvidence,
  getProjectEcosystem,
  parseSemver,
} from '../../src/engine/framework-detector';
import { createDocumentAdapter } from '../../src/adapters/factory';
import { SvelteDocumentAdapter } from '../../src/adapters/svelte';
import { JsxDocumentAdapter } from '../../src/adapters/jsx';
import { ScriptDocumentAdapter } from '../../src/adapters/script';
import { mapSourceFile } from '../../src/engine/source-map';
import { runCanonAudit } from '../../src/engine/canon';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';
import { extractComponentContract } from '../../src/engine/contract';

describe('00 - Foundation: Multi-Framework & Canon Engine (Backend Standards)', () => {
  // =========================================================================
  // 1. Collector & Traversal (Happy, Unhappy, Edge Cases)
  // =========================================================================
  describe('Collector & Extension Traversal', () => {
    test('Happy Path: Collects .svelte, .vue, .astro, .tsx, .jsx, .ts, .js', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-coll-happy-'));
      try {
        await fs.writeFile(join(testDir, 'Component.vue'), '<template><div /></template>');
        await fs.writeFile(join(testDir, 'Component.astro'), '--- --- <div></div>');
        await fs.writeFile(join(testDir, 'Component.svelte'), '<script>let x = 1;</script>');
        await fs.writeFile(join(testDir, 'App.tsx'), 'export const App = () => null;');
        await fs.writeFile(join(testDir, 'script.ts'), 'export const a = 1;');
        await fs.writeFile(join(testDir, 'style.css'), 'body { margin: 0; }'); // ignored

        const files = await collectFiles(testDir);
        const basenames = files.map(f => f.split('/').pop()).sort();

        expect(basenames).toContain('Component.svelte');
        expect(basenames).toContain('Component.vue');
        expect(basenames).toContain('Component.astro');
        expect(basenames).toContain('App.tsx');
        expect(basenames).toContain('script.ts');
        expect(basenames).not.toContain('style.css');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Unhappy & Boundary Paths: Skips ignored directories (.svelte-kit, node_modules, .git)', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-coll-ignored-'));
      try {
        const svelteKitDir = join(testDir, '.svelte-kit');
        const nodeModulesDir = join(testDir, 'node_modules');
        const validDir = join(testDir, 'src');

        await fs.mkdir(svelteKitDir, { recursive: true });
        await fs.mkdir(nodeModulesDir, { recursive: true });
        await fs.mkdir(validDir, { recursive: true });

        await fs.writeFile(join(svelteKitDir, 'Root.svelte'), '<script></script>');
        await fs.writeFile(join(nodeModulesDir, 'Pkg.svelte'), '<script></script>');
        await fs.writeFile(join(validDir, 'App.svelte'), '<script>let ok = true;</script>');

        const files = await collectFiles(testDir);
        const basenames = files.map(f => f.split('/').pop());

        expect(basenames).toContain('App.svelte');
        expect(basenames).not.toContain('Root.svelte');
        expect(basenames).not.toContain('Pkg.svelte');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Edge Case: Empty directory returns empty array without throwing', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-coll-empty-'));
      try {
        const files = await collectFiles(testDir);
        expect(files).toEqual([]);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 2. Framework Classifier & Version Awareness (Happy, Unhappy, Edge Cases)
  // =========================================================================
  describe('Framework Classifier & Version Awareness', () => {
    test('Happy Path: Extension and signature detection', () => {
      // Svelte
      const svelteRes = detectFrameworkWithEvidence('/test/Comp.svelte');
      expect(svelteRes.framework).toBe('svelte');
      expect(svelteRes.evidence.basis).toBe('source');
      expect(svelteRes.evidence.method).toBe('file-extension');

      // Astro
      const astroRes = detectFrameworkWithEvidence('/test/Page.astro');
      expect(astroRes.framework).toBe('astro');
      expect(astroRes.evidence.basis).toBe('source');
      expect(astroRes.evidence.method).toBe('file-extension');

      // SolidJS via import
      const solidRes = detectFrameworkWithEvidence('/test/Comp.tsx', "import { createSignal } from 'solid-js';");
      expect(solidRes.framework).toBe('solid');
      expect(solidRes.evidence.method).toBe('ast-import-signature');

      // Next.js via 'use client'
      const nextRes = detectFrameworkWithEvidence('/test/Button.tsx', "'use client';\nexport function Btn() {}");
      expect(nextRes.framework).toBe('next');
      expect(nextRes.evidence.method).toBe('ast-import-signature');

      // Nuxt via definePageMeta
      const nuxtRes = detectFrameworkWithEvidence('/test/page.ts', "definePageMeta({ layout: 'custom' });");
      expect(nuxtRes.framework).toBe('nuxt');
      expect(nuxtRes.evidence.method).toBe('ast-import-signature');
    });

    test('Unhappy Path: Corrupted package.json falls back cleanly without crash', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-bad-pkg-'));
      try {
        await fs.writeFile(join(testDir, 'package.json'), '{ invalid json ...');
        const eco = getProjectEcosystem(testDir);

        expect(eco.hasVue).toBe(false);
        expect(eco.hasReact).toBe(false);
        expect(eco.hasSolid).toBe(false);
        expect(eco.hasSvelte).toBe(false);

        const res = detectFrameworkWithEvidence(join(testDir, 'file.unknown'), undefined, testDir);
        expect(res.framework).toBe('unknown');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Unhappy Path: Non-existent file path falls back gracefully without ENOENT throw', () => {
      const res = detectFrameworkWithEvidence('/non/existent/path/Component.tsx');
      expect(res.framework).toBe('react'); // JSX fallback candidate
      expect(res.evidence.resolution).toBe('candidate');

      const unknownRes = detectFrameworkWithEvidence('/non/existent/path/Component.xyz');
      expect(unknownRes.framework).toBe('unknown');
      expect(unknownRes.evidence.resolution).toBe('unresolved');
    });

    test('Edge Case: Semver parsing with non-standard, tag, and missing inputs', () => {
      expect(parseSemver('^3.5.13')).toEqual({ rawVersion: '^3.5.13', major: 3, minor: 5, patch: 13 });
      expect(parseSemver('~18.2.0')).toEqual({ rawVersion: '~18.2.0', major: 18, minor: 2, patch: 0 });
      expect(parseSemver('5.0.0-rc.1')).toEqual({ rawVersion: '5.0.0-rc.1', major: 5, minor: 0, patch: 0 });
      expect(parseSemver('latest')).toBeUndefined();
      expect(parseSemver('workspace:*')).toBeUndefined();
      expect(parseSemver(undefined)).toBeUndefined();
    });

    test('Edge Case: SolidJS pragma /* @jsxImportSource solid-js */ detected', () => {
      const pragmaCode = '/** @jsxImportSource solid-js */\nexport function Comp() { return <div />; }';
      const res = detectFrameworkWithEvidence('/test/PragmaComp.tsx', pragmaCode);
      expect(res.framework).toBe('solid');
      expect(res.evidence.method).toBe('ast-import-signature');
    });

    test('Edge Case: SolidJS manifest resolution for unadorned .tsx (Tier 3)', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-solid-manifest-'));
      try {
        await fs.writeFile(
          join(testDir, 'package.json'),
          JSON.stringify({ dependencies: { 'solid-js': '^1.8.0' } })
        );

        // A plain .tsx file with NO imports in a pure SolidJS project
        const code = 'export function SimpleView() { return <h1>Solid</h1>; }';
        const res = detectFrameworkWithEvidence(join(testDir, 'SimpleView.tsx'), code, testDir);

        expect(res.framework).toBe('solid');
        expect(res.evidence.basis).toBe('derived');
        expect(res.evidence.method).toBe('project-manifest');
        expect(res.majorVersion).toBe(1);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 3. Document Adapters (Happy, Unhappy, Edge Cases)
  // =========================================================================
  describe('Document Adapters & Polymorphism', () => {
    test('Happy Path: Correct adapter instance instantiated for each extension', () => {
      expect(createDocumentAdapter('app.vue', '<template/>')).toBeInstanceOf(createDocumentAdapter('app.vue', '').constructor);
      expect(createDocumentAdapter('app.svelte', '<script/>')).toBeInstanceOf(SvelteDocumentAdapter);
      expect(createDocumentAdapter('app.tsx', '')).toBeInstanceOf(JsxDocumentAdapter);
      expect(createDocumentAdapter('app.jsx', '')).toBeInstanceOf(JsxDocumentAdapter);
      expect(createDocumentAdapter('util.ts', '')).toBeInstanceOf(ScriptDocumentAdapter);
    });

    test('Edge Case: Case-insensitive extension routing', () => {
      const svelteUpper = createDocumentAdapter('App.SVELTE', '<script>let z = 3;</script>');
      expect(svelteUpper).toBeInstanceOf(SvelteDocumentAdapter);
      expect(svelteUpper.type).toBe('svelte-sfc');

      const tsxUpper = createDocumentAdapter('Button.TSX', 'export const B = () => null;');
      expect(tsxUpper).toBeInstanceOf(JsxDocumentAdapter);
      expect(tsxUpper.type).toBe('jsx-module');
    });

    test('Unhappy Path: Malformed Svelte markup does not throw crash in adapter', () => {
      const malformedContent = '<script lang="ts">let broken = {</script><div unclosed tag';
      const adapter = new SvelteDocumentAdapter('Broken.svelte', malformedContent);

      expect(() => adapter.getScriptBlocks()).not.toThrow();
      expect(() => adapter.getTemplateBlock()).not.toThrow();
    });

    test('Edge Case: Empty Svelte file (0 bytes) returns empty blocks without error', () => {
      const adapter = new SvelteDocumentAdapter('Empty.svelte', '');
      expect(adapter.getScriptBlocks()).toEqual([]);
      expect(adapter.getTemplateBlock()).toBeNull();
    });

    test('Edge Case: Svelte file with only template and NO script', () => {
      const adapter = new SvelteDocumentAdapter('TemplateOnly.svelte', '<h1>Hello World</h1><p>Static</p>');
      expect(adapter.getScriptBlocks()).toEqual([]);
      const tpl = adapter.getTemplateBlock();
      expect(tpl).not.toBeNull();
      expect(tpl?.content).toContain('<h1>Hello World</h1>');
    });

    test('Edge Case: Svelte file with only script and NO template', () => {
      const adapter = new SvelteDocumentAdapter('ScriptOnly.svelte', '<script>console.log("headless");</script>');
      const blocks = adapter.getScriptBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0].content).toContain('console.log("headless");');
      expect(adapter.getTemplateBlock()).toBeNull();
    });
  });

  // =========================================================================
  // 4. Svelte Source Mapping (Happy, Unhappy, Edge Cases)
  // =========================================================================
  describe('Svelte Source Mapping', () => {
    test('Happy Path: Complete mapping of instance script, template, and style', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-sve-map-'));
      const filePath = join(testDir, 'Full.svelte');
      const content = `<script lang="ts">
let { title = "Default" } = $props();
</script>
<main>
  <h1>{title}</h1>
</main>
<style>
main { padding: 1rem; }
</style>`;

      try {
        await fs.writeFile(filePath, content, 'utf8');
        const map = await mapSourceFile(filePath);

        expect(map.documentType).toBe('svelte-sfc');
        expect(map.framework).toBe('svelte');
        expect(map.status).toBe('complete');
        expect(map.diagnostics).toEqual([]);

        const names = map.regions.map(r => r.name);
        expect(names).toContain('script');
        expect(names).toContain('template');
        expect(names).toContain('style');

        // Verify SHA-256 coordinates match file
        const scriptRegion = map.regions.find(r => r.name === 'script')!;
        const sliced = await readSourceRef(filePath, scriptRegion.ref);
        expect(sliced).toContain('let { title = "Default" } = $props();');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Unhappy Path: Syntax error in Svelte reports partial status and diagnostics without throwing', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-sve-err-'));
      const filePath = join(testDir, 'Invalid.svelte');
      const content = `<script>
let x = ;
</script>`;

      try {
        await fs.writeFile(filePath, content, 'utf8');
        const map = await mapSourceFile(filePath);

        expect(map.documentType).toBe('svelte-sfc');
        expect(map.status).toBe('partial');
        expect(map.diagnostics.length).toBeGreaterThan(0);
        expect(map.diagnostics[0].code).toBe('SVELTE_PARSE_ERROR');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Edge Case: maxRegions correctly truncates returned regions', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-sve-trunc-'));
      const filePath = join(testDir, 'ManyElements.svelte');
      const elements = Array.from({ length: 50 }, (_, i) => `<div>Item ${i}</div>`).join('\n');
      const content = `<script>let a = 1;</script>\n<section>\n${elements}\n</section>`;

      try {
        await fs.writeFile(filePath, content, 'utf8');
        const map = await mapSourceFile(filePath, { maxRegions: 5 });

        expect(map.coverage?.truncated).toBe(true);
        expect(map.status).toBe('partial');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 5. Canonical Diagnostic Engine (Happy, Unhappy, Edge Cases, Negative Tests)
  // =========================================================================
  describe('Canonical Diagnostic Engine (Fact -> Smell -> Canon)', () => {
    test('Happy Path: SolidJS props destructuring anti-pattern detected', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-canon-sol-'));
      const filePath = join(testDir, 'Bad.tsx');
      const code = `export function BadComponent(props: any) {
  const { count, active } = props;
  return <div>{count}</div>;
}`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'solid');
        expect(diags.length).toBe(1);

        const d = diags[0];
        expect(d.ruleId).toBe('solid/no-props-destructure');
        expect(d.severity).toBe('error');
        expect(d.category).toBe('reactivity');
        expect(d.smell.title).toContain('Props Destructuring');
        expect(d.canon.summary).toContain('props.count');

        // Ground Truth Fact Verification
        const sliced = await readSourceRef(filePath, d.fact.ref);
        expect(sliced).toBe('const { count, active } = props;');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Negative Test (No False Positive): SolidJS direct prop access is NOT flagged', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-canon-sol-ok-'));
      const filePath = join(testDir, 'Good.tsx');
      const code = `export function GoodComponent(props: any) {
  return <div>{props.count}</div>;
}`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'solid');
        expect(diags).toEqual([]);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Happy Path: Vue direct prop mutation via v-model detected', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-canon-vue-'));
      const filePath = join(testDir, 'Child.vue');
      const code = `<script setup>const props = defineProps(['foo']);</script>
<template><input v-model="props.foo" /></template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        expect(diags.length).toBe(1);
        expect(diags[0].ruleId).toBe('vue/no-prop-mutation');
        expect(diags[0].severity).toBe('error');

        const sliced = await readSourceRef(filePath, diags[0].fact.ref);
        expect(sliced).toBe('v-model="props.foo"');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Negative Test: Vue 3.5+ reactive props destructuring is NOT flagged (No false positive)', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-vue35-'));
      const filePath = join(testDir, 'ModernVue.vue');
      const code = `<script setup lang="ts">
const { count = 0 } = defineProps<{ count?: number }>();
</script>
<template><div>{count}</div></template>`;

      try {
        // Mock package.json declaring Vue 3.5.13
        await fs.writeFile(
          join(testDir, 'package.json'),
          JSON.stringify({ dependencies: { vue: '^3.5.13' } })
        );
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'vue');
        // Vue 3.5+ should NOT flag defineProps destructure!
        expect(diags.find(d => d.ruleId === 'vue/no-props-destructure')).toBeUndefined();
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Happy Path: Next.js event handler in Server Component detected', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-rsc-'));
      const filePath = join(testDir, 'ServerComp.tsx');
      // No 'use client' directive
      const code = `export default function ServerComp() {
  return <button onClick={() => console.log('click')}>Action</button>;
}`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'next');
        expect(diags.length).toBe(1);
        expect(diags[0].ruleId).toBe('next/rsc-event-handler');
        expect(diags[0].severity).toBe('error');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Negative Test: Next.js Client Component with "use client" is NOT flagged', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-client-ok-'));
      const filePath = join(testDir, 'ClientComp.tsx');
      const code = `'use client';
export default function ClientComp() {
  return <button onClick={() => console.log('ok')}>Action</button>;
}`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'next');
        expect(diags).toEqual([]);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Edge Case: Diagnostic filtering by category, severity, and maxDiagnostics', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-filter-'));
      const filePath = join(testDir, 'MultiSmell.svelte');
      const code = `<script>
export let propA = 1;
export let propB = 2;
$: sum = propA + propB;
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        // Filter: maxDiagnostics = 1
        const capped = await runCanonAudit(snapshot, content, 'svelte', { maxDiagnostics: 1 });
        expect(capped.length).toBe(1);

        // Filter: severity = 'error' (these are warnings, so 0 returned)
        const errors = await runCanonAudit(snapshot, content, 'svelte', { severity: 'error' });
        expect(errors.length).toBe(0);

        // Filter: category = 'legacy-syntax'
        const legacy = await runCanonAudit(snapshot, content, 'svelte', { category: 'legacy-syntax' });
        expect(legacy.length).toBe(3);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('Unhappy Path: Empty file content returns empty diagnostics without error', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-empty-diag-'));
      const filePath = join(testDir, 'Empty.tsx');
      try {
        await fs.writeFile(filePath, '', 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);

        const diags = await runCanonAudit(snapshot, content, 'react');
        expect(diags).toEqual([]);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 6. Contract Integration & extractComponentContract (Regression Checks)
  // =========================================================================
  describe('Contract Integration & extractComponentContract', () => {
    test('extractComponentContract identifies Svelte component framework correctly', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-contract-sve-'));
      const filePath = join(testDir, 'Badge.svelte');
      const code = `<script lang="ts">
let { label } = $props();
</script>
<span class="badge">{label}</span>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const contract = await extractComponentContract(filePath);

        expect(contract.component).toBe('Badge');
        expect(contract.framework).toBe('svelte'); // Must NOT be 'unknown'
        expect(contract.filePath).toBe(filePath);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('extractComponentContract identifies SolidJS framework without collapsing to unknown', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-contract-sol-'));
      const filePath = join(testDir, 'SolidButton.tsx');
      const code = `import { createSignal } from 'solid-js';
export function SolidButton() {
  const [val] = createSignal(1);
  return <button>{val()}</button>;
}`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const contract = await extractComponentContract(filePath);

        expect(contract.component).toBe('SolidButton');
        expect(contract.framework).toBe('solid'); // Must NOT be 'unknown'
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('extractComponentContract embeds patternDiagnostics directly in contract', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-contract-diag-'));
      const filePath = join(testDir, 'SmellyVue.vue');
      const code = `<script setup>const props = defineProps(['val']);</script>
<template><input v-model="props.val" /></template>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const contract = await extractComponentContract(filePath);

        expect(contract.framework).toBe('vue');
        expect(contract.patternDiagnostics).toBeDefined();
        expect(contract.patternDiagnostics?.length).toBeGreaterThan(0);
        expect(contract.patternDiagnostics?.[0].ruleId).toBe('vue/no-prop-mutation');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });
});
