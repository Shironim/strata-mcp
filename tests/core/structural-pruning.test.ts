import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractComponentContract } from '../../src/engine/contract';
import { extractLayoutStructure } from '../../src/engine/layout-extractor';
import { batchParser } from '../../src/engine/storage/delta-sync';
import { getComponentTree, resolveImportPath } from '../../src/engine/tree';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import { findCodeTool } from '../../src/tools/find-code';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { StrataTelemetry } from '../../src/engine/telemetry';
import { main } from '../../src/cli';
import { STRATA_VERSION } from '../../src/version';

test('contract retains declared types and unresolved evidence without guessed props or globals', async () => {
  const root = await mkdtemp('/tmp/strata-structural-contract-');
  try {
    await writeFile(join(root, 'package.json'), '{"dependencies":{"react":"19.0.0"}}');
    const file = join(root, 'Widget.tsx');
    await writeFile(file, `import { memo, useState } from 'react';
      import type { Missing } from './missing';
      interface Props extends Missing { invoice: { price: string }; }
      // invoice.price; route('orders.index')
      export function Widget({ invoice }: Props) {
        const [count, setCount] = useState(0);
        return <p>{invoice.price}</p>;
      }`);
    const contract = await extractComponentContract(file, { workspaceRoot: root });
    expect(contract.props.find(prop => prop.name === 'invoice')?.type).toContain('price: string');
    expect(contract.unresolvedTypes?.length).toBeGreaterThan(0);
    expect(contract).not.toHaveProperty('inferredProps');
    expect(contract).not.toHaveProperty('globalSymbols');
    const schema = TOOL_CATALOG.find(tool => tool.name === 'inspect_component')!.inputSchema.properties!;
    for (const key of ['infer_props', 'resolve_globals', 'max_function_lines']) expect(schema).not.toHaveProperty(key);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('layout retains nested bindings and visibility without semantic section guesses', () => {
  const layout = extractLayoutStructure('Card.vue', `<template>
    <main class="grid gap-4">
      <template #header><div :class="{ hidden: !open }">Header</div></template>
      <footer v-if="canSave"><button>Save</button></footer>
    </main>
  </template>`, 'vue')!;
  expect(layout.rootWrapper?.tag).toBe('main');
  expect(layout.rootWrapper?.layoutTokens).toContain('grid');
  expect(layout.dynamicBindings.some(binding => binding.condition === '!open')).toBe(true);
  expect(layout.visibilityDirectives.some(item => item.expression === 'canSave')).toBe(true);
  expect(layout).not.toHaveProperty('sections');
});

test('graph traversals share extensionless Svelte and Svelte index resolution', async () => {
  const root = await mkdtemp('/tmp/strata-shared-resolver-');
  try {
    const parent = join(root, 'App.svelte'), child = join(root, 'Child.svelte');
    await writeFile(parent, '<script>import Child from "./Child";</script><Child/>');
    await writeFile(child, '<p>Child</p>');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'index.svelte'), '<p>Nested</p>');
    expect(resolveImportPath(parent, './Child')).toBe(child);
    expect(resolveImportPath(parent, './nested')).toBe(join(root, 'nested', 'index.svelte'));
    const downward = await getComponentTree({ entryPath: parent, workspaceRoot: root, targetPath: root, maxDepth: 2 });
    expect(downward.root.children.some(node => node.filePath === child)).toBe(true);
    const upward = await getComponentTree({ entryPath: child, workspaceRoot: root, targetPath: root, direction: 'upward', maxDepth: 2 });
    expect(upward.root.children.some(node => node.filePath === parent)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('batch parser reuses contract state dependencies and framework identity', async () => {
  const root = await mkdtemp('/tmp/strata-parse-reuse-');
  try {
    await writeFile(join(root, 'package.json'), '{"dependencies":{"react":"19.0.0"}}');
    const file = join(root, 'Card.tsx');
    await writeFile(file, `import { useContext } from 'react';
      import { ThemeContext } from './context';
      export function Card(){ const theme = useContext(ThemeContext); return <p>{theme}</p>; }`);
    const parsed = (await batchParser([file], root, new Map(), false)).files.get(file)!;
    expect(parsed.contract?.stateDependencies?.contexts).toContain('ThemeContext');
    expect(parsed.stateDeps).toBe(parsed.contract!.stateDependencies!);
    expect(parsed.framework).toBe(parsed.contract!.framework);
    expect(parsed.compName).toBe(parsed.contract!.component);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI help/version and direct tools perform no remote update check or version enrichment', async () => {
  const root = await mkdtemp('/tmp/strata-local-version-');
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'));
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await writeFile(join(root, 'App.vue'), '<template><p>App</p></template>');
    await main(['--version']);
    expect(log.mock.calls.some(call => call[0] === `strata v${STRATA_VERSION}`)).toBe(true);
    await main(['--help']);
    for (const result of [
      await findCodeTool.handler({ action: 'map', path: root, format: 'json' }),
      await auditFrontendTool.handler({ target: 'api-contracts', path: root, format: 'json' }),
    ]) {
      expect(result.isError).not.toBe(true);
      expect(result).not.toHaveProperty('runtime_version');
      expect(result.structuredContent).not.toHaveProperty('runtime_version');
      expect(JSON.stringify(result)).not.toContain('latest_version');
      expect(JSON.stringify(result)).not.toContain('update_available');
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test('response costs stay in telemetry and measure the serialized final result', async () => {
  const root = await mkdtemp('/tmp/strata-response-cost-');
  try {
    await mkdir(join(root, '.strata'));
    await writeFile(join(root, 'App.vue'), '<template><p>App</p></template>');
    const result = await findCodeTool.handler({ action: 'map', path: root, format: 'json' });
    expect(result.structuredContent).not.toHaveProperty('cost');
    StrataTelemetry.recordToolResponse({ event: 'tool_call_completed', tool: 'find_code', duration_ms: 7,
      input: {}, status: 'success' }, result, root);
    const record = JSON.parse((await readFile(join(root, '.strata', 'strata.log'), 'utf8')).trim());
    expect(record.duration_ms).toBe(7);
    expect(record.metrics.response_bytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
