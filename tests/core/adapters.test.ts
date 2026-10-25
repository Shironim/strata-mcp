import { describe, expect, it } from 'bun:test';
import { createDocumentAdapter } from '../../src/adapters/factory';

describe('Document Adapter Pattern (src/adapters/)', () => {
  it('creates VueDocumentAdapter for .vue file', () => {
    const raw = `<template><div>Hello</div></template><script>export default {}</script>`;
    const adapter = createDocumentAdapter('Button.vue', raw);

    expect(adapter.type).toBe('vue');
    expect(adapter.getScriptBlocks().length).toBe(1);
    expect(adapter.getTemplateBlock()).not.toBeNull();
    expect(adapter.isJsx()).toBe(false);
  });

  it('creates AstroDocumentAdapter for .astro file', () => {
    const raw = `---
const x = 1;
---
<div>Astro</div>`;
    const adapter = createDocumentAdapter('Page.astro', raw);

    expect(adapter.type).toBe('astro');
    expect(adapter.getScriptBlocks().length).toBe(1);
    expect(adapter.getTemplateBlock()).not.toBeNull();
    expect(adapter.isJsx()).toBe(false);
  });

  it('creates SvelteDocumentAdapter for .svelte file', () => {
    const raw = `<script lang="ts">
let { name = 'World' } = $props();
</script>
<h1>Hello {name}</h1>`;
    const adapter = createDocumentAdapter('Greeting.svelte', raw);

    expect(adapter.type).toBe('svelte-sfc');
    expect(adapter.getScriptBlocks().length).toBe(1);
    expect(adapter.getTemplateBlock()).not.toBeNull();
    expect(adapter.isJsx()).toBe(false);
  });

  it('creates JsxDocumentAdapter for .tsx file', () => {
    const raw = `export function App() { return <div>App</div>; }`;
    const adapter = createDocumentAdapter('App.tsx', raw);

    expect(adapter.type).toBe('jsx-module');
    expect(adapter.getScriptBlocks().length).toBe(1);
    expect(adapter.getTemplateBlock()).toBeNull();
    expect(adapter.isJsx()).toBe(true);
  });
});
