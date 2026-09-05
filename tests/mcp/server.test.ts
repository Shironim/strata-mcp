import { describe, expect, it } from 'bun:test';
import { createMcpServer } from '../../src/mcp';
import { join } from 'node:path';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('MCP Server & 5 Core Tools', () => {
  it('registers exactly 5 Core MCP tools in tool definitions', async () => {
    const server = createMcpServer();
    expect(server).toBeDefined();

    const listHandler = (server as any)._requestHandlers?.get('tools/list');
    expect(listHandler).toBeDefined();

    const toolsResult = await listHandler({ method: 'tools/list', params: {} });
    expect(toolsResult.tools.length).toBe(5);

    const toolNames = toolsResult.tools.map((t: any) => t.name);
    expect(toolNames).toEqual([
      'find_code',
      'inspect_component',
      'get_component_tree',
      'trace_state',
      'audit_frontend',
    ]);
  });

  describe('Core Tool 1: find_code', () => {
    it('searches component usages across templates and script', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            component: 'OldButton',
            path: FIXTURES_DIR,
            output_format: 'json',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      const parsed = JSON.parse(response.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(4);
    });

    it('searches ast-grep patterns across codebase', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            pattern: 'ref($$$)',
            path: FIXTURES_DIR,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('ref');
    });

    it('dumps CST syntax tree when action is dump_ast', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            action: 'dump_ast',
            code: 'const a = 1;',
            language: 'ts',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Debug CST');
    });

    it('tests in-memory pattern/rule against code snippet', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            code: 'const count = ref(0);',
            pattern: 'const $NAME = ref($VAL)',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.matchCount).toBe(1);
    });

    it('returns error when dump_ast is called with unsupported language', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            action: 'dump_ast',
            code: 'const a = 1;',
            language: 'unsupported_lang_xyz',
          },
        },
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('ast-grep dump failed');
    });
  });

  describe('Core Tool 2: inspect_component', () => {
    it('extracts component contract (props/emits/slots) by default', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: {
            path: join(FIXTURES_DIR, 'TemplateEmit.vue'),
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Component: TemplateEmit');
      expect(response.content[0].text).toContain('add-laptop');
    });

    it('slices a specific symbol body with line numbers and blast radius', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: {
            path: join(FIXTURES_DIR, 'TemplateEmit.vue'),
            symbol: 'formatPrice',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Symbol: `formatPrice`');
      expect(response.content[0].text).toContain('function formatPrice');
    });

    it('audits template-to-script event handlers when audit_events is true', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: {
            path: join(FIXTURES_DIR, 'TemplateEmit.vue'),
            audit_events: true,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Event Handler Audit');
      expect(response.content[0].text).toContain('add-laptop');
    });
  });

  describe('Core Tool 3: get_component_tree', () => {
    it('resolves downward component hierarchy tree from entry_path', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'get_component_tree',
          arguments: {
            entry_path: join(FIXTURES_DIR, 'PageOne.vue'),
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('PageOne.vue');
    });

    it('resolves upward blast radius from leaf component', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'get_component_tree',
          arguments: {
            entry_path: join(FIXTURES_DIR, 'OldButton.vue'),
            direction: 'upward',
            target_path: FIXTURES_DIR,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Upward Blast Radius');
    });

    it('resolves component tree directly from route path', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'get_component_tree',
          arguments: {
            route: '/dashboard',
            target_path: join(import.meta.dir, '../mock-projects/inertia-app'),
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Route: /dashboard');
      expect(response.content[0].text).toContain('Dashboard.vue');
    });
  });

  describe('Core Tool 4: trace_state', () => {
    it('queries flat state impact across workspace files', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'trace_state',
          arguments: {
            identifier: 'useRouter',
            target_path: FIXTURES_DIR,
            depth: 1,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('State Impact Analysis for: useRouter');
    });

    it('traces multi-hop dependency chain when depth > 1', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'trace_state',
          arguments: {
            identifier: 'useRouter',
            target_path: FIXTURES_DIR,
            depth: 3,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('State Dependency Chain: `useRouter`');
    });
  });

  describe('Core Tool 5: audit_frontend', () => {
    it('scans routes when target is routes', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'audit_frontend',
          arguments: {
            target: 'routes',
            target_path: join(import.meta.dir, '../mock-projects/inertia-app'),
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Route Manifest');
    });

    it('audits dead components when target is dead-components', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'audit_frontend',
          arguments: {
            target: 'dead-components',
            target_path: FIXTURES_DIR,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Unused Components');
    });

    it('executes full multi-target audit when target is all', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'audit_frontend',
          arguments: {
            target: 'all',
            target_path: join(import.meta.dir, '../mock-projects/inertia-app'),
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Frontend Architecture & Health Audit');
    });

    it('audits template structural similarity when target is similar-templates', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'audit_frontend',
          arguments: {
            target: 'similar-templates',
            target_path: FIXTURES_DIR,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('Template Similarity & Abstraction Opportunities');
    });
  });

  describe('Core Tools Enhanced Capabilities (Breaking & Clean Specs)', () => {
    it('find_code tolerates language: "vue" without ast-grep error', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            pattern: 'ref($$$)',
            path: FIXTURES_DIR,
            language: 'vue',
          },
        },
      });

      expect(response.isError).toBeFalsy();
    });

    it('inspect_component extracts inferred props and global symbols', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: {
            path: join(FIXTURES_DIR, 'RuntimePropsButton.vue'),
            infer_props: true,
            resolve_globals: true,
            output_format: 'json',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      const contract = JSON.parse(response.content[0].text);
      expect(contract.props).toBeDefined();
    });

    it('get_component_tree supports include_props parameter', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'get_component_tree',
          arguments: {
            entry_path: join(FIXTURES_DIR, 'PageOne.vue'),
            include_props: true,
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toBeDefined();
    });

    it('trace_state supports role filter for mutators and readers', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'trace_state',
          arguments: {
            identifier: 'useCartStore',
            target_path: FIXTURES_DIR,
            role: 'all',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain('State Impact Analysis');
    });
  });

  it('rejects unknown tool calls cleanly', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'nonexistent_tool',
        arguments: {},
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown tool name: nonexistent_tool');
  });
});
