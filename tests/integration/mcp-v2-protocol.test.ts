import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../src/mcp';
import { ANALYSIS_LIMITS } from '../../src/analysis-supervisor';
import { defaultSemanticPool, defaultWarmDbPool } from '../../src/engine/v2';
import { clearLastKnownProjectRoot } from '../../src/engine/path-resolver';

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

      // 7. Prompts reflect new cognitive playbooks (including open-apps)
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual([
        'open-apps',
        'onboard-workspace',
        'trace-bug',
        'safe-refactor',
      ]);

      const appsPrompt = await client.getPrompt({
        name: 'open-apps',
        arguments: { workspace_path: workDir },
      });
      const promptText = appsPrompt.messages
        .filter((m) => m.content.type === 'text')
        .map((m) => (m.content as { type: 'text'; text: string }).text)
        .join('\n');
      expect(promptText).toContain('map_workspace');
      expect(promptText).toContain('Strata Explorer');
      expect(promptText).toContain('Overview & Health tab');

      // 8. All 5 tools expose max_bytes in schema, and max_bytes can be passed without schema rejection
      for (const t of tools) {
        expect((t.inputSchema as { properties?: Record<string, unknown> }).properties?.max_bytes).toBeDefined();
      }
      const budgetedInspect = await client.callTool({
        name: 'inspect_file',
        arguments: {
          root: workDir,
          path: 'packages/ui/src/OrderSummaryCard.vue',
          sections: ['outline', 'contract'],
          format: 'json',
          max_bytes: 32768,
        },
      });
      expect(budgetedInspect.isError).toBeFalsy();
      expect(ANALYSIS_LIMITS.queued).toBeGreaterThanOrEqual(16);

      // 9. Hybrid MCP App UI: map_workspace exposes ui://strata/explorer.html & entrypoints while headless tools stay lean
      const mapToolSpec = tools.find((t) => t.name === 'map_workspace') as any;
      expect(mapToolSpec?._meta?.ui?.resourceUri).toBe('ui://strata/explorer.html');
      expect(mapToolSpec?._meta?.['com.google.antigravity/ui']?.entrypoints).toEqual([
        { type: 'aux_pane', title: 'Strata Explorer' },
        { type: 'global', title: 'Strata' },
      ]);

      const { resources } = await client.listResources();
      const uiResMeta = resources.find((r) => r.uri === 'ui://strata/explorer.html');
      expect(uiResMeta?.mimeType).toBe('text/html;profile=mcp-app');
      expect(resources.some((r) => r.uri === 'strata://apps')).toBe(true);

      const appsRes = await client.readResource({
        uri: `strata://apps?workspace=${encodeURIComponent(workDir)}`,
      });
      const appsJson = JSON.parse((appsRes.contents[0] as { text?: string })?.text ?? '{}');
      expect(appsJson.ui_resource).toBe('ui://strata/explorer.html');
      expect(appsJson.open_via_tools).toEqual(['map_workspace']);
      expect(Array.isArray(appsJson.actionable_actions)).toBe(true);

      const uiHtmlRes = await client.readResource({ uri: 'ui://strata/explorer.html' });
      const htmlContent = (uiHtmlRes.contents[0] as { text?: string; mimeType?: string })?.text ?? '';
      expect(uiHtmlRes.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
      expect(htmlContent).toContain('<!doctype html>');
      expect(htmlContent).toContain('Strata Explorer');

      const mapDefaultRes = await client.callTool({
        name: 'map_workspace',
        arguments: { root: workDir },
      });
      expect(mapDefaultRes.isError).toBeFalsy();
      expect((mapDefaultRes as any).structuredContent?.data?.view).toBe('overview');

      const inspectTextRes = await client.callTool({
        name: 'inspect_file',
        arguments: { root: workDir, path: 'packages/ui/src/OrderSummaryCard.vue', sections: ['contract'] },
      });
      expect(inspectTextRes.isError).toBeFalsy();
      expect((inspectTextRes as any).structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      defaultSemanticPool.disposeAll();
      defaultWarmDbPool.close(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30000);

  test('resolves active workspace via MCP roots/list, tracks roots/list_changed, and respects explicit override', async () => {
    const vueSrc = resolve(import.meta.dir, '../mock-projects/vue-app');
    const reactSrc = resolve(import.meta.dir, '../mock-projects/react-app');
    const workDir1 = await mkdtemp(join(tmpdir(), 'strata-mcp-root-1-'));
    const workDir2 = await mkdtemp(join(tmpdir(), 'strata-mcp-root-2-'));
    clearLastKnownProjectRoot();

    let activeRoots = [{ uri: pathToFileURL(workDir1).href, name: 'vue-app' }];
    const server = createMcpServer();
    const client = new Client(
      { name: 'strata-roots-test-client', version: '0.12.1' },
      { capabilities: { roots: { listChanged: true } } }
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: activeRoots }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await cp(vueSrc, workDir1, { recursive: true });
      await cp(reactSrc, workDir2, { recursive: true });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // 1. open-apps without workspace_path uses client root 1
      const prompt1 = await client.getPrompt({ name: 'open-apps' });
      const prompt1Text = prompt1.messages
        .filter((m) => m.content.type === 'text')
        .map((m) => (m.content as { type: 'text'; text: string }).text)
        .join('\n');
      expect(prompt1Text).toContain(workDir1);
      expect(prompt1Text).not.toContain(workDir2);

      // 2. map_workspace without root uses client root 1
      const map1 = await client.callTool({ name: 'map_workspace', arguments: { view: 'overview' } });
      expect(map1.isError).toBeFalsy();
      expect((map1.content as Array<{ text: string }>)[0].text).toContain(workDir1);

      // 3. Switching client roots + sending notifications/roots/list_changed updates active workspace
      activeRoots = [{ uri: pathToFileURL(workDir2).href, name: 'react-app' }];
      await client.sendRootsListChanged();

      const overview2 = await client.readResource({ uri: 'strata://project/overview' });
      const overview2Json = JSON.parse((overview2.contents[0] as { text?: string })?.text ?? '{}');
      expect(overview2Json.scope).toBe(workDir2);

      // 4. Explicit workspace_path argument still overrides client root
      const explicitPrompt = await client.getPrompt({
        name: 'open-apps',
        arguments: { workspace_path: workDir1 },
      });
      const explicitText = explicitPrompt.messages
        .filter((m) => m.content.type === 'text')
        .map((m) => (m.content as { type: 'text'; text: string }).text)
        .join('\n');
      expect(explicitText).toContain(workDir1);
    } finally {
      clearLastKnownProjectRoot();
      await client.close();
      await server.close();
      defaultSemanticPool.disposeAll();
      defaultWarmDbPool.close(workDir1);
      defaultWarmDbPool.close(workDir2);
      await rm(workDir1, { recursive: true, force: true });
      await rm(workDir2, { recursive: true, force: true });
    }
  }, 30000);

  test('guards against auto-scanning $HOME when client provides no roots and no explicit root is passed', async () => {
    const originalCwd = process.cwd();
    clearLastKnownProjectRoot();
    const server = createMcpServer();
    const client = new Client({ name: 'strata-no-roots-client', version: '0.12.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      process.chdir(homedir());
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // 1. open-apps skips scanning $HOME and instructs the agent to substitute <active-workspace-root>
      const promptRes = await client.getPrompt({ name: 'open-apps' });
      expect(promptRes.messages.length).toBe(1);
      const text = (promptRes.messages[0]?.content as { type: 'text'; text: string }).text;
      expect(text).toContain('<active-workspace-root>');
      expect(text).toContain('automatic scanning was skipped');

      // 2. Resource read without ?workspace returns WORKSPACE_ROOT_REQUIRED diagnostic
      const resOverview = await client.readResource({ uri: 'strata://project/overview' });
      const overviewJson = JSON.parse((resOverview.contents[0] as { text?: string })?.text ?? '{}');
      expect(overviewJson.workspace_root).toBeNull();
      expect(overviewJson.diagnostics?.[0]?.code).toBe('WORKSPACE_ROOT_REQUIRED');

      // 3. Tool call without root returns WORKSPACE_ROOT_REQUIRED error
      const mapRes = await client.callTool({ name: 'map_workspace', arguments: { view: 'overview' } });
      expect(mapRes.isError).toBe(true);
      expect((mapRes.content as Array<{ text: string }>)[0].text).toContain('WORKSPACE_ROOT_REQUIRED');
    } finally {
      process.chdir(originalCwd);
      clearLastKnownProjectRoot();
      await client.close();
      await server.close();
    }
  }, 15000);
});
