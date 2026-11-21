import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('MCP server loaded runtime - JSON-RPC protocol handshake, tool enumeration and execution', async () => {
  const mcpEntrypoint = process.env.STRATA_MCP_ENTRYPOINT || join(import.meta.dir, '../../src/mcp.ts');
  const fixturesDir = join(import.meta.dir, '../fixtures');

  // Spawn actual MCP server process communicating via stdio pipes
  const proc = Bun.spawn(['bun', 'run', mcpEntrypoint], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readMessage = async (): Promise<any> => {
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            return JSON.parse(line);
          } catch {
            // Ignore non-JSON log lines
          }
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return null;
  };

  const sendRequest = (req: Record<string, any>) => {
    proc.stdin.write(JSON.stringify(req) + '\n');
    proc.stdin.flush();
  };

  try {
    // 1. Initialize Handshake
    sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-harness', version: '1.0.0' },
      },
    });

    const initResponse = await readMessage();
    expect(initResponse).not.toBeNull();
    expect(initResponse.id).toBe(1);
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe('strata-mcp');
    expect(initResponse.result.capabilities.tools).toBeDefined();
    expect(initResponse.result.capabilities.resources).toBeDefined();
    expect(initResponse.result.capabilities.prompts).toBeDefined();

    // 2. Initialized Notification
    sendRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // 3. List Tools
    sendRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const listResponse = await readMessage();
    expect(listResponse).not.toBeNull();
    expect(listResponse.id).toBe(2);
    expect(listResponse.result.tools).toBeDefined();
    expect(listResponse.result.tools.length).toBe(6);

    const toolNames = listResponse.result.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      'audit_frontend',
      'find_code',
      'generate_patch_plan',
      'get_component_tree',
      'inspect_component',
      'trace_state',
    ]);

    // 4. Call Tool (find_code map)
    sendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'find_code',
        arguments: {
          action: 'map',
          target_path: fixturesDir,
        },
      },
    });

    const callResponse = await readMessage();
    expect(callResponse).not.toBeNull();
    expect(callResponse.id).toBe(3);
    expect(callResponse.result).toBeDefined();
    expect(callResponse.result.isError).toBeFalsy();
    expect(Array.isArray(callResponse.result.content)).toBe(true);
    expect(callResponse.result.content[0].text).toContain('Frontend map');
    expect(callResponse.result.structuredContent).toBeUndefined();

    // 5. Call Tool (inspect_component contract on a fixture)
    sendRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'inspect_component',
        arguments: {
          path: join(fixturesDir, 'PageOne.vue'),
          output_format: 'json',
        },
      },
    });

    const inspectResponse = await readMessage();
    expect(inspectResponse).not.toBeNull();
    expect(inspectResponse.id).toBe(4);
    expect(inspectResponse.result).toBeDefined();
    expect(inspectResponse.result.isError).toBeFalsy();
    const parsedContract = JSON.parse(inspectResponse.result.content[0].text);
    expect(parsedContract.component).toBe('PageOne');
    expect(parsedContract.retrieval).toBeDefined();
    expect(parsedContract.retrieval.engineRevision).toBeDefined();

    // Budget includes the entire result object, not JSON-RPC framing or only its matches.
    const snippet = Array.from({ length: 50 }, (_, i) => `const v${i} = "${'é🙂'.repeat(40)}";`).join('\n');
    for (const [id, max_bytes] of [[5, 512], [6, 16000]]) {
      sendRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'find_code', arguments: {
        code: snippet, mode: 'literal', pattern: 'const', format: 'json', max_bytes,
      } } });
      const response = await readMessage();
      expect(response.id).toBe(id);
      expect(Buffer.byteLength(JSON.stringify(response.result), 'utf8')).toBeLessThanOrEqual(max_bytes!);
      if (max_bytes === 512) {
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toContain('BUDGET_METADATA_TOO_LARGE');
      } else {
        expect(response.result.isError).toBeFalsy();
        expect(response.result.structuredContent.continuationToken).toBeDefined();
        expect(response.result.structuredContent.matches.length).toBeLessThan(50);
        expect(response.result.structuredContent).not.toHaveProperty('cost');
      }
    }

    // 6. List Resources & Resource Templates
    sendRequest({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} });
    const listResourcesRes = await readMessage();
    expect(listResourcesRes.id).toBe(7);
    expect(listResourcesRes.result.resources.map((r: any) => r.uri)).toEqual([
      'strata://project/overview',
      'strata://components/index',
    ]);

    sendRequest({ jsonrpc: '2.0', id: 8, method: 'resources/templates/list', params: {} });
    const listTemplatesRes = await readMessage();
    expect(listTemplatesRes.id).toBe(8);
    expect(listTemplatesRes.result.resourceTemplates.map((t: any) => t.uriTemplate)).toEqual([
      'strata://component/{name}',
    ]);

    // 7. Read Resources (project overview, components index, and component template)
    for (const [id, uri] of [
      [9, 'strata://project/overview'],
      [10, 'strata://components/index'],
      [11, 'strata://component/PageOne'],
    ] as const) {
      sendRequest({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } });
      const readRes = await readMessage();
      expect(readRes.id).toBe(id);
      expect(readRes.error).toBeUndefined();
      expect(readRes.result.contents.length).toBe(1);
      expect(readRes.result.contents[0].mimeType).toBe('application/json');
      const text = readRes.result.contents[0].text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16000);
      const parsed = JSON.parse(text);
      if (uri === 'strata://component/PageOne') {
        expect(parsed.found).toBe(true);
        expect(parsed.matches[0].name).toBe('PageOne');
      }
    }

    // 8. List & Get Prompts
    sendRequest({ jsonrpc: '2.0', id: 12, method: 'prompts/list', params: {} });
    const listPromptsRes = await readMessage();
    expect(listPromptsRes.id).toBe(12);
    expect(listPromptsRes.result.prompts.map((p: any) => p.name)).toEqual([
      'trace-state-bug',
      'safe-component-patch',
      'audit-component-tree',
    ]);

    sendRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'prompts/get',
      params: { name: 'safe-component-patch', arguments: { component: 'PageOne.vue', refactor_type: 'rename_prop' } },
    });
    const getPromptRes = await readMessage();
    expect(getPromptRes.id).toBe(13);
    expect(getPromptRes.error).toBeUndefined();
    expect(getPromptRes.result.messages.length).toBe(2);
    expect(getPromptRes.result.messages[0].content.type).toBe('resource');
    expect(getPromptRes.result.messages[0].content.resource.uri).toBe('strata://project/overview');
    expect(getPromptRes.result.messages[1].content.type).toBe('text');
    expect(getPromptRes.result.messages[1].content.text).toContain('generate_patch_plan');

    // 9. Progress notifications via _meta.progressToken
    sendRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'get_component_tree',
        arguments: {
          path: join(fixturesDir, 'PageOne.vue'),
          direction: 'downward',
          target_path: fixturesDir,
        },
        _meta: {
          progressToken: 'tree-progress-1',
        },
      },
    });

    const progressNotifications: any[] = [];
    let treeResponse: any = null;
    while (!treeResponse) {
      const msg = await readMessage();
      expect(msg).not.toBeNull();
      if (msg.method === 'notifications/progress') {
        progressNotifications.push(msg);
      } else if (msg.id === 14) {
        treeResponse = msg;
      }
    }
    expect(treeResponse.result.isError).toBeFalsy();
    expect(progressNotifications.length).toBeGreaterThanOrEqual(1);
    expect(progressNotifications[0].params.progressToken).toBe('tree-progress-1');
  } finally {
    // Gracefully close stdin and wait for process exit
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  }
});

