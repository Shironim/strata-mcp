import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createMcpServer } from '../../src/mcp';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');
const INERTIA_APP_DIR = join(import.meta.dir, '../mock-projects/inertia-app');

describe('Sprint 1 — MCP JSON Structured Output Integration', () => {
  it('returns valid parseable JSON for get_component_tree when output_format is json', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'get_component_tree',
        arguments: {
          entry_path: join(FIXTURES_DIR, 'AsyncPage.vue'),
          output_format: 'json',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toBeDefined();
    expect(parsed.root.component).toBe('AsyncPage.vue');
    expect(Array.isArray(parsed.root.children)).toBe(true);
  });

  it('returns valid parseable JSON for inspect_component when output_format is json', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'inspect_component',
        arguments: {
          path: join(FIXTURES_DIR, 'TemplateEmit.vue'),
          output_format: 'json',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toBeDefined();
    expect(parsed.component).toBe('TemplateEmit');
    expect(Array.isArray(parsed.emits)).toBe(true);
  });

  it('returns valid parseable JSON for trace_state when output_format is json', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'trace_state',
        arguments: {
          identifier: 'useRouter',
          target_path: FIXTURES_DIR,
          output_format: 'json',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toBeDefined();
    expect(parsed.identifier).toBe('useRouter');
  });

  it('returns valid parseable JSON for audit_frontend when output_format is json', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'audit_frontend',
        arguments: {
          target: 'routes',
          target_path: INERTIA_APP_DIR,
          output_format: 'json',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.routes)).toBe(true);
  });
});
