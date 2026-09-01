import { describe, expect, it } from 'bun:test';
import { createMcpServer } from '../../src/mcp';
import { join } from 'node:path';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('MCP Server & Tools (Task 5 DoD)', () => {
  it('registers all required MCP tools in tool definitions', async () => {
    const server = createMcpServer();
    // Verify server creation
    expect(server).toBeDefined();

    // Check list tools handler
    const listHandler = (server as any)._requestHandlers?.get('tools/list');
    expect(listHandler).toBeDefined();

    const toolsResult = await listHandler({ method: 'tools/list', params: {} });
    expect(toolsResult.tools.length).toBe(8);

    const toolNames = toolsResult.tools.map((t: any) => t.name);
    expect(toolNames).toContain('find_code');
    expect(toolNames).toContain('find_code_by_rule');
    expect(toolNames).toContain('find_component_usage');
    expect(toolNames).toContain('dump_syntax_tree');
    expect(toolNames).toContain('test_match_code_rule');
    expect(toolNames).toContain('extract_component_contract');
    expect(toolNames).toContain('get_component_tree');
    expect(toolNames).toContain('find_unused_components');
  });

  it('invokes find_component_usage via MCP call tool handler', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');
    expect(callHandler).toBeDefined();

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'find_component_usage',
        arguments: {
          component_name: 'OldButton',
          path: FIXTURES_DIR,
          output_format: 'json',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    expect(response.content[0].text).toBeDefined();

    const parsed = JSON.parse(response.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(4);
  });

  it('invokes dump_syntax_tree via MCP call tool handler', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'dump_syntax_tree',
        arguments: {
          code: 'const a = 1;',
          language: 'ts',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    expect(response.content[0].text).toContain('Debug CST');
  });

  it('invokes test_match_code_rule for in-memory dynamic lazy import (TC-2.1)', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const rule = `
id: test-lazy
language: ts
rule:
  pattern: defineAsyncComponent(() => import($$$))
`;

    const code = "const ProductModal = defineAsyncComponent(() => import('../components/ProductModal.vue'));";

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'test_match_code_rule',
        arguments: {
          rule_yaml: rule,
          code_snippet: code,
          language: 'ts',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.matches[0].line).toBe(1);
  });

  it('invokes test_match_code_rule for interface member matching (TC-2.7)', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const rule = `
id: test-prop-sig
language: ts
rule:
  kind: property_signature
  has:
    pattern: '?'
`;

    const code = `interface Props {
  id: string;
  onViewDetails?: (p: Product) => void;
}`;

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'test_match_code_rule',
        arguments: {
          rule_yaml: rule,
          code_snippet: code,
          language: 'ts',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.matches[0].line).toBe(3);
    expect(parsed.matches[0].text).toContain('onViewDetails');
  });

  it('returns informative hint on unquoted YAML mapping characters (TC-2.6)', async () => {
    const server = createMcpServer();
    const callHandler = (server as any)._requestHandlers?.get('tools/call');

    const brokenRule = `
id: broken-rule
language: ts
rule:
  pattern: $NAME?: $$$
`;

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'test_match_code_rule',
        arguments: {
          rule_yaml: brokenRule,
          code_snippet: 'const a = 1;',
          language: 'ts',
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('mapping values are not allowed');
    expect(response.content[0].text).toContain('Hint: wrap your pattern with quotes');
  });
});
