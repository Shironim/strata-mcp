import { beforeEach, afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServer } from '../../src/mcp';
import { dbRegistry, closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';

const roots: string[] = [];
beforeEach(() => { closeAllDatabases(); });
afterEach(() => { closeAllDatabases(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

test('a successful component-tree call leaves no analysis database in the MCP parent', async () => {
  const root = mkdtempSync('/tmp/strata-isolation-'); roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  writeFileSync(join(root, 'App.vue'), '<template><div /></template>');
  mkdirSync(join(root, '.strata'), { recursive: true });
  const server = createMcpServer();
  try {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const response = await handler({method: 'tools/call', params: {name: 'get_component_tree', arguments: {path: join(root, 'App.vue')}}});
    expect(response.isError).toBeFalsy();
    expect(response.content[0].text).toContain('App');
    expect(dbRegistry.size).toBe(0);
  } finally { await server.close(); }
});

test('calling component-tree on an unindexed workspace does not create .strata and returns NOT_INDEXED', async () => {
  const root = mkdtempSync('/tmp/strata-unindexed-'); roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  writeFileSync(join(root, 'App.vue'), '<template><div /></template>');
  const server = createMcpServer();
  try {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const response = await handler({method: 'tools/call', params: {name: 'get_component_tree', arguments: {path: join(root, 'App.vue')}}});
    expect(response.isError).toBeFalsy();
    expect(response.content[0].text).toContain('NOT_INDEXED');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(root, '.strata'))).toBe(false);
  } finally { await server.close(); }
});

test('oversized requests fail before analysis starts', async () => {
  const server = createMcpServer();
  try {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const response = await handler({method: 'tools/call', params: {name: 'find_code', arguments: {query: 'x'.repeat(2 * 1024 * 1024 + 1)}}});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('REQUEST_TOO_LARGE');
  } finally { await server.close(); }
});
