import { expect, test } from 'bun:test';
import { withRetrievalEvidence } from '../../src/tools/retrieval-response';
import { withDecisionResponse } from '../../src/tools/decision-response';
import { sourceRetrievalEvidence } from '../../src/engine/retrieval-evidence';
import { readSourceSnapshot } from '../../src/engine/source-file';
import { TOOLS } from '../../src/tools';
import { createMcpServer } from '../../src/mcp';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { inspectComponentTool } from '../../src/tools/inspect-component';

test('an empty unverified search is inconclusive, never proof of absence', async () => {
  const tool = withRetrievalEvidence({ name: 'find_code', description: '', inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: '[]' }], structuredContent: { matches: [] } }) });
  const result = await tool.handler({ path: '/tmp', format: 'json' });
  expect(result.structuredContent?.decision).toMatchObject({ status: 'partial', emptyOutcome: 'inconclusive' });
  expect(result.content[0]?.text).toBe('[]');
  expect(result.structuredContent).not.toHaveProperty('cost');
  expect((result.structuredContent?.decision as any).next[0].action).toBe('review-coverage');
});

test('syntax hints never certify a framework version or non-Vue capability', () => {
  for (const [path, syntax, status] of [['Child.vue', 'vue-sfc', 'partial'], ['Child.svelte', 'svelte', 'unknown'], ['src', 'unknown', 'unknown']]) {
    const result = withDecisionResponse({ content: [] }, 'inspect_component', { path });
    expect((result.structuredContent?.decision as any).capability).toMatchObject({ syntax, status, frameworkVersion: 'unknown' });
  }
});

test('early budget rejection carries actionable decision without running analysis', async () => {
  const tool = withRetrievalEvidence({ name: 'find_code', description: '', inputSchema: { type: 'object' },
    handler: async () => { throw new Error('must not execute'); } });
  const result = await tool.handler({ max_bytes: 1 });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('BUDGET_TOO_SMALL');
  expect(result.structuredContent?.decision).toMatchObject({ status: 'unknown', emptyOutcome: 'analysis-failed' });
});

test('not indexed is not checked rather than no matches', async () => {
  const tool = withRetrievalEvidence({ name: 'get_component_tree', description: '', inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: '[strata NOT_INDEXED] initialize' }] }) });
  const result = await tool.handler({});
  expect(result.structuredContent?.decision).toMatchObject({ status: 'unknown', emptyOutcome: 'not-checked' });
});

test('stale identity overrides success and offers fresh retrieval', async () => {
  const { snapshot } = await readSourceSnapshot(import.meta.path);
  const retrieval = await sourceRetrievalEvidence({ workspace: import.meta.dir, snapshot, policy: 'test', query: {}, complete: true, selectionReason: 'test' });
  retrieval.freshness = 'stale';
  const result = withDecisionResponse({ content: [{ type: 'text', text: 'source' }], structuredContent: { retrieval } }, 'inspect_component', { path: import.meta.path });
  expect(result.structuredContent?.decision).toMatchObject({ status: 'stale', next: [{ action: 'retrieve-again' }] });
});

test('unrelated empty arrays do not assert absence of consumers', () => {
  const result = withDecisionResponse({ content: [], structuredContent: { diagnostics: [] } }, 'get_component_tree', {});
  expect(result.structuredContent?.decision).toMatchObject({ status: 'unknown', emptyOutcome: 'not-asserted' });
});

test('all public handlers expose a decision even on rejected requests', async () => {
  for (const tool of TOOLS) {
    const result = await tool.handler({ max_bytes: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.decision).toMatchObject({ status: 'unknown', emptyOutcome: 'analysis-failed' });
    expect(result.content[0]?.text).toContain('BUDGET_TOO_SMALL');
  }
});

test('tools/list publishes annotations and valid example inputs without loading workers', async () => {
  const server = createMcpServer();
  try {
    const handler = (server as any)._requestHandlers.get('tools/list');
    const result = await handler({ method: 'tools/list', params: {} });
    expect(result.tools).toHaveLength(6);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.inputSchema.properties.response_detail.default).toBe('full');
      expect(tool.description).toContain('Example input:');
      expect(tool.description).toContain('Use ');
    }
  } finally { await server.close(); }
});

test('symbol inspection uses the explicit workspace for callers outside the source directory', async () => {
  const root = await mkdtemp('/tmp/strata-prd-symbol-');
  try {
    await mkdir(join(root, 'nested'));
    const source = join(root, 'nested', 'utils.ts');
    const parent = join(root, 'Parent.vue');
    await writeFile(source, 'export function doSomething() { return 42; }');
    await writeFile(parent, '<script setup>import { doSomething } from "./nested/utils";</script><template>{{ doSomething() }}</template>');
    getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    await syncWorkspace(root);
    const result = await inspectComponentTool.handler({ path: source, project_root: root, symbol: 'doSomething', format: 'json' });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent?.blastRadius as any)?.callers.map((item: any) => item.filePath)).toContain(parent);
    expect((result.structuredContent?.retrieval as any).workspace).toBe(root);
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});
