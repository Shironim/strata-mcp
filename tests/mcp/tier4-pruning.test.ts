import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { CAPABILITY_MANIFEST } from '../../src/tools/capabilities';
import { VALID_AUDIT_TARGETS } from '../../src/engine/path-resolver';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';

test('audit schema and capabilities expose exactly the retained targets and no obsolete parameters', () => {
  const expected = ['routes', 'api-contracts', 'dead-components', 'dead-state', 'all'].sort();
  const properties = TOOL_CATALOG.find(tool => tool.name === 'audit_frontend')!.inputSchema.properties as Record<string, any>;
  expect([...properties.target.enum].sort()).toEqual(expected);
  expect([...VALID_AUDIT_TARGETS].sort()).toEqual(expected);
  expect(CAPABILITY_MANIFEST.audit_frontend.map(operation => operation.id).sort()).toEqual(expected);
  expect(properties).not.toHaveProperty('threshold');
  expect(properties).not.toHaveProperty('exemplar_path');
});

test('removed audit targets and aliases fail explicitly without falling through to all', async () => {
  for (const target of ['archetype-drift', 'archetype_drift', 'archetype', 'design-tokens', 'design_tokens', 'design', 'similar-templates', 'similar_templates', 'bundle-health', 'bundle_health', 'bundle']) {
    const result = await auditFrontendTool.handler({ path: '/tmp/strata-pruning-no-scan', target });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid audit target');
    expect(result.content[0].text).toContain('Supported targets:');
  }
});

test('all returns the four retained analyses with API facts and no legacy audit sections', async () => {
  const root = await mkdtemp('/tmp/strata-tier4-all-');
  try {
    await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3.5.13"}}');
    await writeFile(join(root, 'App.vue'), '<script setup>fetch("/api/items")</script><template><main>Items</main></template>');
    getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    const result = await auditFrontendTool.handler({ path: root, target: 'all', format: 'json' });
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent!;
    for (const key of ['routes', 'unusedComponents', 'unusedState', 'apiContracts']) expect(data).toHaveProperty(key);
    for (const key of ['designSystemAudit', 'bundleAudit', 'clusters', 'violations']) expect(data).not.toHaveProperty(key);
    expect((data.apiContracts as any).endpoints.some((item: any) => item.endpoint === '/api/items')).toBe(true);
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});
