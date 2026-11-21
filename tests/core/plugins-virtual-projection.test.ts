import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  defaultPluginRegistry,
  hashSourceContent,
  vuePlugin,
  sveltePlugin,
  astroPlugin,
  reactPlugin,
} from '../../src/plugins';

function assertCleanTsxParse(virtualPath: string, virtualCode: string) {
  const sf = ts.createSourceFile(
    virtualPath,
    virtualCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  expect(parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  return sf;
}

describe('Fase 1: FrameworkPlugin & Virtual TS Projection', () => {
  const monorepoRoot = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('Vue plugin projects SFC to valid TSX with exact bidirectional offset round-trip and spread omissions', () => {
    const pagePath = resolve(monorepoRoot, 'apps/web/pages/orders/[id].vue');
    const raw = readFileSync(pagePath, 'utf8');
    const doc = defaultPluginRegistry.projectFile(pagePath, raw)!;

    expect(doc).not.toBeNull();
    expect(doc.framework).toBe('vue');
    expect(doc.isIdentity).toBe(false);
    expect(doc.virtualPath).toBe(`${pagePath}.__strata__.tsx`);

    assertCleanTsxParse(doc.virtualPath, doc.virtualCode);

    // 1. Round-trip inside <script setup>
    const fnToken = 'async function onCancel';
    const origFnOffset = raw.indexOf(fnToken);
    expect(origFnOffset).toBeGreaterThan(0);
    const virtFnOffset = doc.toVirtualOffset(origFnOffset);
    expect(virtFnOffset).not.toBeNull();
    expect(doc.virtualCode.slice(virtFnOffset!, virtFnOffset! + fnToken.length)).toBe(fnToken);

    const backSpan = doc.toOriginalSpan(virtFnOffset!, virtFnOffset! + fnToken.length);
    expect(backSpan).toEqual({
      start: origFnOffset,
      end: origFnOffset + fnToken.length,
      kind: 'script-setup',
    });

    // 2. Round-trip inside <template> expression
    const exprToken = 'orderStore.state.activeOrder.customerName';
    const origExprOffset = raw.indexOf(exprToken);
    expect(origExprOffset).toBeGreaterThan(0);
    const virtExprOffset = doc.toVirtualOffset(origExprOffset);
    expect(virtExprOffset).not.toBeNull();
    expect(doc.virtualCode.slice(virtExprOffset!, virtExprOffset! + exprToken.length)).toBe(exprToken);

    const backExpr = doc.toOriginalSpan(virtExprOffset!, virtExprOffset! + exprToken.length);
    expect(backExpr).toEqual({
      start: origExprOffset,
      end: origExprOffset + exprToken.length,
      kind: 'template-expr',
    });

    // 3. Dynamic spread omission (v-bind="extraButtonAttrs") is captured
    expect(doc.omissions.some((o) => o.code === 'DYNAMIC_SPREAD')).toBe(true);
    const spreadOmission = doc.omissions.find((o) => o.code === 'DYNAMIC_SPREAD')!;
    expect(raw.slice(spreadOmission.originalStart, spreadOmission.originalEnd)).toContain('v-bind="extraButtonAttrs"');

    // 4. Tier 1 facts capture all rendered custom components
    const facts = vuePlugin.extractTier1Facts(doc, raw);
    const tagNames = facts.componentUsages.map((c) => c.normalizedName);
    expect(tagNames).toEqual(['OrderBadge', 'OrderSummaryCard', 'BaseButton']);
    expect(facts.componentUsages.find((c) => c.normalizedName === 'BaseButton')?.hasDynamicSpread).toBe(true);
  });

  test('Vue plugin extracts slots and kebab-to-PascalCase renamed component tag mapping', () => {
    const raw = `<script setup lang="ts">
import MyCard from './MyCard.vue';
const title = 'Hello';
</script>
<template>
  <my-card :card-title="title">
    <slot name="header" />
  </my-card>
</template>`;
    const doc = vuePlugin.projectToVirtualTs('/tmp/Test.vue', raw, hashSourceContent(raw));
    assertCleanTsxParse(doc.virtualPath, doc.virtualCode);

    const virtTagIdx = doc.virtualCode.indexOf('<MyCard');
    expect(virtTagIdx).toBeGreaterThan(0);
    const mappedBack = doc.toOriginalSpan(virtTagIdx + 1, virtTagIdx + 7);
    expect(mappedBack).not.toBeNull();
    expect(raw.slice(mappedBack!.start, mappedBack!.end)).toBe('my-card');

    const facts = vuePlugin.extractTier1Facts(doc, raw);
    expect(facts.slots).toEqual(['header']);
  });

  test('React plugin provides identity VirtualDocument, RSC boundary, and JSX spread omissions', () => {
    const panelPath = resolve(monorepoRoot, 'apps/admin/app/orders/OrderPanel.tsx');
    const raw = readFileSync(panelPath, 'utf8');
    const doc = defaultPluginRegistry.projectFile(panelPath, raw)!;

    expect(doc.framework).toBe('react');
    expect(doc.isIdentity).toBe(true);
    expect(doc.virtualPath).toBe(panelPath);

    const fnIdx = raw.indexOf('handleApprove');
    expect(doc.toVirtualOffset(fnIdx)).toBe(fnIdx);
    expect(doc.toOriginalSpan(fnIdx, fnIdx + 13)).toEqual({
      start: fnIdx,
      end: fnIdx + 13,
      kind: 'script',
    });

    const facts = reactPlugin.extractTier1Facts(doc, raw);
    expect(facts.renderBoundary).toBe('client');
    expect(facts.boundaryDirective).toBe('use client');
    expect(facts.componentUsages.map((c) => c.normalizedName)).toEqual(['ActionCard']);
    expect(facts.omissions.some((o) => o.code === 'DYNAMIC_SPREAD')).toBe(true);
  });

  test('Svelte plugin projects script + markup expressions to valid TSX with bidirectional offsets', () => {
    const raw = `<script lang="ts">
import Modal from './Modal.svelte';
let { title, extra }: { title: string; extra: Record<string, unknown> } = $props();
function onClose() {}
</script>
<Modal {title} on:close={onClose} {...extra}>
  <slot name="footer" />
</Modal>`;
    const doc = sveltePlugin.projectToVirtualTs('/tmp/Dialog.svelte', raw, hashSourceContent(raw));
    assertCleanTsxParse(doc.virtualPath, doc.virtualCode);

    const scriptIdx = raw.indexOf('function onClose');
    const virtIdx = doc.toVirtualOffset(scriptIdx)!;
    expect(doc.virtualCode.slice(virtIdx, virtIdx + 16)).toBe('function onClose');
    expect(doc.toOriginalSpan(virtIdx, virtIdx + 16)?.start).toBe(scriptIdx);

    const facts = sveltePlugin.extractTier1Facts(doc, raw);
    expect(facts.componentUsages.map((c) => c.normalizedName)).toEqual(['Modal']);
    expect(facts.componentUsages[0].hasDynamicSpread).toBe(true);
    expect(facts.slots).toEqual(['footer']);
    expect(facts.omissions.some((o) => o.code === 'DYNAMIC_SPREAD')).toBe(true);
  });

  test('Astro plugin projects frontmatter + client island component props to valid TSX', () => {
    const raw = `---
import ProductCard from '../components/ProductCard.tsx';
const heading = 'Featured';
const extra = { featured: true };
---
<section>
  <ProductCard client:visible title={heading} {...extra} />
  <slot name="aside" />
</section>`;
    const doc = astroPlugin.projectToVirtualTs('/tmp/Catalog.astro', raw, hashSourceContent(raw));
    assertCleanTsxParse(doc.virtualPath, doc.virtualCode);

    const fmIdx = raw.indexOf("const heading = 'Featured'");
    const virtIdx = doc.toVirtualOffset(fmIdx)!;
    expect(doc.virtualCode.slice(virtIdx, virtIdx + 26)).toBe("const heading = 'Featured'");
    expect(doc.toOriginalSpan(virtIdx, virtIdx + 26)?.start).toBe(fmIdx);

    const facts = astroPlugin.extractTier1Facts(doc, raw);
    expect(facts.renderBoundary).toBe('island');
    expect(facts.boundaryDirective).toBe('client:visible');
    expect(facts.componentUsages.map((c) => c.normalizedName)).toEqual(['ProductCard']);
    expect(facts.componentUsages[0].hasDynamicSpread).toBe(true);
    expect(facts.slots).toEqual(['aside']);
  });
});
