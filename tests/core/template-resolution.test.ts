import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { getComponentTree } from '../../src/engine/tree';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { findCodeTool } from '../../src/tools/find-code';
import { StrataTelemetry } from '../../src/engine/telemetry';

let tempDir = '';
afterEach(async () => {
  closeAllDatabases();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

test('template parser ignores HTML/JS comment decoys and string literals when resolving rendered edges', async () => {
  tempDir = await mkdtemp('/tmp/strata-template-decoys-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');

  // Real rendered component
  await writeFile(join(root, 'RealChild.vue'), '<template><div>Real Child</div></template>\n');

  // Decoy components
  await writeFile(join(root, 'DecoyHtmlComment.vue'), '<template><div>Decoy 1</div></template>\n');
  await writeFile(join(root, 'DecoyStringLiteral.vue'), '<template><div>Decoy 2</div></template>\n');
  await writeFile(join(root, 'DecoyLineComment.vue'), '<template><div>Decoy 3</div></template>\n');
  await writeFile(join(root, 'DecoyBlockComment.vue'), '<template><div>Decoy 4</div></template>\n');

  // Parent containing real render plus decoys in comments and strings
  await writeFile(
    join(root, 'Parent.vue'),
    `<script setup lang="ts">
import RealChild from './RealChild.vue';
import DecoyHtmlComment from './DecoyHtmlComment.vue';
import DecoyStringLiteral from './DecoyStringLiteral.vue';
import DecoyLineComment from './DecoyLineComment.vue';
import DecoyBlockComment from './DecoyBlockComment.vue';

// <DecoyLineComment />
/*
  <DecoyBlockComment />
*/
const banner = '<DecoyStringLiteral />';
</script>
<template>
  <div>
    <!-- <DecoyHtmlComment /> -->
    <RealChild />
  </div>
</template>
`
  );

  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);
  const db = getWorkspaceDatabase(root, { enableWatcher: false });

  // Query edges from Parent.vue
  const edges = db.query(`
    SELECT c.name, e.is_rendered, e.import_type
    FROM edges e
    JOIN files p ON p.id = e.parent_file_id
    JOIN components c ON c.file_id = e.child_file_id
    WHERE p.path = ?
    ORDER BY c.name
  `).all(join(root, 'Parent.vue')) as Array<{ name: string; is_rendered: number; import_type: string }>;

  // Oracle: Only RealChild must have is_rendered = 1
  const renderedChildren = edges.filter(e => e.is_rendered === 1).map(e => e.name);
  const importOnlyChildren = edges.filter(e => e.is_rendered === 0).map(e => e.name);

  expect(renderedChildren).toEqual(['RealChild']);
  expect(importOnlyChildren.sort()).toEqual([
    'DecoyBlockComment',
    'DecoyHtmlComment',
    'DecoyLineComment',
    'DecoyStringLiteral',
  ]);

  // Downward component tree must ONLY include RealChild in children
  const tree = await getComponentTree({ entryPath: join(root, 'Parent.vue'), targetPath: root });
  expect(tree.root.children.map(c => c.component)).toEqual(['RealChild.vue']);
});

test('dynamic component tags are classified as candidate resolution without guessing target', async () => {
  tempDir = await mkdtemp('/tmp/strata-dynamic-candidate-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'TabA.vue'), '<template><div>Tab A</div></template>\n');
  await writeFile(join(root, 'TabB.vue'), '<template><div>Tab B</div></template>\n');

  await writeFile(
    join(root, 'DynamicContainer.vue'),
    `<script setup lang="ts">
import { ref } from 'vue';
import TabA from './TabA.vue';
import TabB from './TabB.vue';

const currentTab = ref('TabA');
</script>
<template>
  <main>
    <component :is="currentTab" />
  </main>
</template>
`
  );

  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);

  const tree = await getComponentTree({ entryPath: join(root, 'DynamicContainer.vue'), targetPath: root });
  // Engine must classify the bound :is as dynamic candidate, not guessing TabA or TabB as resolved static children
  expect(tree.root.children.length).toBe(1);
  expect(tree.root.children[0].isDynamic).toBe(true);
  expect(tree.root.children[0].component).toBe('<component :is="currentTab">');
  expect(tree.root.children.some(c => c.component.includes('TabA') || c.component.includes('TabB'))).toBe(false);

  expect(tree.diagnostics).toBeDefined();
  const dynamicCandidate = tree.diagnostics?.find((d: any) => d.code === 'VUE_DYNAMIC_COMPONENT');
  expect(dynamicCandidate).toBeDefined();
  expect((dynamicCandidate as any).expression).toBe('currentTab');
});

test('telemetry ledger records tool execution metrics and summary aggregations', async () => {
  tempDir = await mkdtemp('/tmp/strata-telemetry-ledger-');
  const root = tempDir;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'Component.vue'), '<template><button>Click</button></template>\n');

  // Initialize workspace database with telemetry log sink
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  await syncWorkspace(root);

  // Record tool calls via StrataTelemetry into active workspace
  StrataTelemetry.recordToolCall({
    event: 'tool_call_completed',
    tool: 'find_code',
    duration_ms: 15,
    status: 'success',
    input: { action: 'map', target_path: root },
    metrics: { bytes_out: 1200, lines_out: 40, items_found: 1 },
  }, root);

  StrataTelemetry.recordToolCall({
    event: 'tool_call_completed',
    tool: 'inspect_component',
    duration_ms: 22,
    status: 'success',
    input: { path: join(root, 'Component.vue') },
    metrics: { bytes_out: 850, lines_out: 25, items_found: 1 },
  }, root);

  StrataTelemetry.recordToolCall({
    event: 'tool_call_completed',
    tool: 'audit_frontend',
    duration_ms: 35,
    status: 'success',
    input: { target: 'routes' },
    metrics: { bytes_out: 450, lines_out: 15, items_found: 0 },
  }, root);

  // Verify telemetry log exists and has recorded entries
  const logPath = StrataTelemetry.getLogPath(root);
  expect(existsSync(logPath)).toBe(true);

  const logContent = readFileSync(logPath, 'utf8').trim();
  const logLines = logContent.split('\n').filter(Boolean);
  expect(logLines.length).toBeGreaterThanOrEqual(3);

  // Check summary aggregation
  const summary = StrataTelemetry.getSummary(root);
  expect(summary.totalCalls).toBeGreaterThanOrEqual(3);
  expect(summary.errorCount).toBe(0);
  expect(summary.totalBytesOut).toBe(2500);
  expect(summary.totalItemsFound).toBe(2);
  expect(summary.toolBreakdown).toBeDefined();
  expect(summary.toolBreakdown['find_code'].totalBytesOut).toBe(1200);
  expect(summary.toolBreakdown['inspect_component'].totalBytesOut).toBe(850);
  expect(summary.toolBreakdown['audit_frontend'].totalBytesOut).toBe(450);
});
