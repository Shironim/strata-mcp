import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeEventExpression,
  auditEventHandlers,
  formatEventHandlerAuditAsText,
} from '../../src/engine/reactivity';

describe('Vue Event Handler & Reactivity Audit Engine', () => {
  it('analyzes event expressions correctly', () => {
    expect(analyzeEventExpression('handleSubmit')).toEqual({
      identifier: 'handleSubmit',
      isInline: false,
    });

    expect(analyzeEventExpression('handleSubmit($event)')).toEqual({
      identifier: 'handleSubmit',
      isInline: false,
    });

    expect(analyzeEventExpression('() => handleSave(item)')).toEqual({
      identifier: 'handleSave',
      isInline: false,
    });

    expect(analyzeEventExpression('count++')).toEqual({
      identifier: 'count',
      isInline: true,
    });

    expect(analyzeEventExpression('isOpen = !isOpen')).toEqual({
      identifier: 'isOpen',
      isInline: true,
    });
  });

  it('audits a Vue SFC detecting valid, broken, inline, and dead handlers', async () => {
    const tempDir = join(tmpdir(), `strata-reactivity-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const vueFile = join(tempDir, 'TestForm.vue');

    const content = [
      '<template>',
      '  <form @submit.prevent="submitForm">',
      '    <p>{{ count }}</p>',
      '    <!-- Valid handler -->',
      '    <button @click="handleClick">Click Me</button>',
      '    <!-- Broken handler: not defined in script -->',
      '    <button @click="simpanData">Save Missing</button>',
      '    <!-- Inline expression -->',
      '    <button @click="count++">Increment</button>',
      '  </form>',
      '</template>',
      '',
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      '',
      'const count = ref(0);',
      '',
      'function submitForm() {',
      '  console.log("Submitting...");',
      '}',
      '',
      'const handleClick = () => {',
      '  console.log("Clicked!");',
      '};',
      '',
      '// Dead script handler: never bound in template or called in lifecycle',
      'function unusedDeadHelper() {',
      '  console.log("I am dead code");',
      '}',
      '</script>',
    ].join('\n');

    await fs.writeFile(vueFile, content, 'utf8');

    const result = await auditEventHandlers({ path: vueFile });

    expect(result.totalEventBindings).toBe(4);

    // Valid handlers
    const validNames = result.validHandlers.map((h) => h.handlerName);
    expect(validNames).toContain('submitForm');
    expect(validNames).toContain('handleClick');

    // Broken handlers
    expect(result.brokenHandlers.length).toBe(1);
    expect(result.brokenHandlers[0].handlerName).toBe('simpanData');
    expect(result.brokenHandlers[0].event).toBe('click');
    expect(result.brokenHandlers[0].status).toBe('broken');

    // Inline expressions
    expect(result.inlineExpressions.length).toBe(1);
    expect(result.inlineExpressions[0].handlerName).toContain('count++');

    // Dead script handlers
    const deadNames = result.deadScriptHandlers.map((d) => d.name);
    expect(deadNames).toContain('unusedDeadHelper');

    // Formatting check
    const formatted = formatEventHandlerAuditAsText(result);
    expect(formatted).toContain('BROKEN EVENT HANDLERS (1)');
    expect(formatted).toContain('simpanData');
    expect(formatted).toContain('DEAD SCRIPT HANDLERS (1)');
    expect(formatted).toContain('unusedDeadHelper');

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('correctly serializes multiple Vue template event modifiers without [object Object]', async () => {
    const tempDir = join(tmpdir(), `strata-modifiers-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const vueFile = join(tempDir, 'ModifierTest.vue');

    const content = [
      '<template>',
      '  <input @keydown.enter.prevent="handleManualSubmit" />',
      '</template>',
      '',
      '<script setup lang="ts">',
      'function handleManualSubmit() {',
      '  console.log("Submitted");',
      '}',
      '</script>',
    ].join('\n');

    await fs.writeFile(vueFile, content, 'utf8');

    const result = await auditEventHandlers({ path: vueFile });

    expect(result.totalEventBindings).toBe(1);
    expect(result.validHandlers.length).toBe(1);
    expect(result.validHandlers[0].event).toBe('keydown.enter.prevent');
    expect(result.validHandlers[0].event).not.toContain('[object Object]');

    const formatted = formatEventHandlerAuditAsText(result);
    expect(formatted).toContain('@keydown.enter.prevent');
    expect(formatted).not.toContain('[object Object]');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('links UI event handlers to 1-hop outbound API calls and backend target hints', async () => {
    const tempDir = join(tmpdir(), `strata-event-api-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const vueFile = join(tempDir, 'CadetForm.vue');

    const content = [
      '<template>',
      '  <div>',
      '    <button @click="saveCadet">Save Cadet</button>',
      '    <button @click="isDeleting = true; axios.delete(\'/api/v1/cadets/1\')">Delete Cadet</button>',
      '  </div>',
      '</template>',
      '',
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      'import axios from "axios";',
      '',
      'const isDeleting = ref(false);',
      '',
      'async function saveCadet() {',
      '  await axios.post("/api/v1/cadets", { name: "John" });',
      '}',
      '</script>',
    ].join('\n');

    await fs.writeFile(vueFile, content, 'utf8');

    const result = await auditEventHandlers({ path: vueFile });

    expect(result.totalEventBindings).toBe(2);

    // 1. Valid handler saveCadet with 1-hop API link
    const saveHandler = result.validHandlers.find((h) => h.handlerName === 'saveCadet');
    expect(saveHandler).toBeDefined();
    expect(saveHandler?.outboundApi).toBeDefined();
    expect(saveHandler?.outboundApi?.boundaryType).toBe('axios');
    expect(saveHandler?.outboundApi?.method).toBe('POST');
    expect(saveHandler?.outboundApi?.targetEndpoint).toBe('/api/v1/cadets');
    expect(saveHandler?.outboundApi?.backendTargetHint?.suggestedSymbols[0]).toContain('Cadet');

    // 2. Inline expression with 1-hop API link
    const deleteInline = result.inlineExpressions.find((ie) => ie.handlerName.includes('axios.delete'));
    expect(deleteInline).toBeDefined();
    expect(deleteInline?.outboundApi).toBeDefined();
    expect(deleteInline?.outboundApi?.boundaryType).toBe('axios');
    expect(deleteInline?.outboundApi?.method).toBe('DELETE');
    expect(deleteInline?.outboundApi?.targetEndpoint).toBe('/api/v1/cadets/1');

    // 3. Formatted markdown output includes the outbound API and backend hint
    const formatted = formatEventHandlerAuditAsText(result);
    expect(formatted).toContain('@click="saveCadet"');
    expect(formatted).toContain('[axios] POST /api/v1/cadets');
    expect(formatted).toContain('Backend: Cadet');
    expect(formatted).toContain('[axios] DELETE /api/v1/cadets/1');

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
