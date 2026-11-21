import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp';
import { defaultSemanticPool, defaultWarmDbPool } from '../../src/engine/v2';

describe('Fase 5: MCP Protocol Integration for 5 Cognitive Tools (0.11.0)', () => {
  const monorepoSrc = resolve(import.meta.dir, '../mock-projects/monorepo-app');

  test('exposes exactly the 5 cognitive tools and completes full Orient -> Inspect -> Graph -> Read -> Search workflow', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'strata-mcp-v2-proto-'));
    const server = createMcpServer();
    const client = new Client({ name: 'strata-v2-test-client', version: '0.11.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await cp(monorepoSrc, workDir, { recursive: true });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // 1. ListTools: exactly 5 cognitive primitives
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'map_workspace',
        'inspect_file',
        'query_graph',
        'read_slice',
        'search_code',
      ]);

      // 2. map_workspace (Orient)
      const mapRes = await client.callTool({
        name: 'map_workspace',
        arguments: { root: workDir, view: 'overview' },
      });
      expect(mapRes.isError).toBeFalsy();
      const mapText = (mapRes.content as Array<{ text: string }>)[0].text;
      expect(mapText).toContain('4 package(s)');
      expect(mapText).toContain('apps/web');
      expect(mapText).toContain('apps/admin');

      // 3. inspect_file (Outline & TypeChecker-resolved contract)
      const inspectRes = await client.callTool({
        name: 'inspect_file',
        arguments: {
          root: workDir,
          path: 'packages/ui/src/OrderSummaryCard.vue',
          format: 'json',
        },
      });
      expect(inspectRes.isError).toBeFalsy();
      const inspectJson = JSON.parse((inspectRes.content as Array<{ text: string }>)[0].text);
      expect(inspectJson.verification).toBe('semantic');
      expect(inspectJson.data.contract.props.map((p: any) => p.name).sort()).toEqual([
        'compact',
        'customerName',
        'id',
        'status',
        'totalCents',
      ]);

      // 4. query_graph (impact with dynamic spread omission)
      const impactRes = await client.callTool({
        name: 'query_graph',
        arguments: {
          root: workDir,
          query: 'impact',
          target: { file: 'packages/ui/src/BaseButton.vue', member: 'variant' },
        },
      });
      expect(impactRes.isError).toBeFalsy();
      const impactText = (impactRes.content as Array<{ text: string }>)[0].text;
      expect(impactText).toContain('OMISSIONS');
      expect(impactText).toContain('DYNAMIC_SPREAD');

      // 5. search_code -> read_slice (composable handle round-trip)
      const searchRes = await client.callTool({
        name: 'search_code',
        arguments: {
          root: workDir,
          query: 'formatOrderTotal',
          kind: 'symbol',
          format: 'json',
        },
      });
      expect(searchRes.isError).toBeFalsy();
      const searchJson = JSON.parse((searchRes.content as Array<{ text: string }>)[0].text);
      const refHandle = searchJson.data.matches[0].sourceRef;
      expect(refHandle).toStartWith('ref:');

      const sliceRes = await client.callTool({
        name: 'read_slice',
        arguments: { root: workDir, source_ref: refHandle },
      });
      expect(sliceRes.isError).toBeFalsy();
      const sliceText = (sliceRes.content as Array<{ text: string }>)[0].text;
      expect(sliceText).toContain('export function formatOrderTotal');

      // 6. Centralized error mapping on invalid path traversal
      const errRes = await client.callTool({
        name: 'read_slice',
        arguments: { root: workDir, path: '../../../etc/passwd' },
      });
      expect(errRes.isError).toBe(true);
      expect((errRes.content as Array<{ text: string }>)[0].text).toContain('WORKSPACE_BOUNDARY_ERROR');

      // 7. Prompts reflect new cognitive playbooks
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual([
        'onboard-workspace',
        'trace-bug',
        'safe-refactor',
      ]);
    } finally {
      await client.close();
      await server.close();
      defaultSemanticPool.disposeAll();
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);
});
