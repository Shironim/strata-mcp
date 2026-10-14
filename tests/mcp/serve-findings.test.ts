import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMcpServer, extractItemsFound } from '../../src/mcp';
import { clearLastKnownProjectRoot, getLastKnownProjectRoot, setLastKnownProjectRoot } from '../../src/engine/path-resolver';
import { StrataTelemetry } from '../../src/engine/telemetry';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('strata serve bug fixes (SERVE-01 to SERVE-05)', () => {
  let tempDir: string;

  beforeEach(() => {
    clearLastKnownProjectRoot();
    tempDir = mkdtempSync(join(tmpdir(), 'strata-serve-test-'));
  });

  afterEach(() => {
    clearLastKnownProjectRoot();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('SERVE-01: Multi-root project continuity across calls', () => {
    it('propagates detected project root from absolute path call to subsequent relative path call', async () => {
      const projectDir = join(tempDir, 'project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ dependencies: { vue: '3' } }));
      writeFileSync(
        join(projectDir, 'Button.vue'),
        '<script setup>\ndefineProps({ title: String })\n</script>\n<template><div>{{ title }}</div></template>'
      );

      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      // Call 1: Absolute path
      const res1 = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: { path: join(projectDir, 'Button.vue') },
        },
      });

      expect(res1.isError).toBeFalsy();
      expect(getLastKnownProjectRoot()).toBe(projectDir);

      // Call 2: Relative path without explicit root
      const res2 = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: { path: 'Button.vue' },
        },
      });

      expect(res2.isError).toBeFalsy();
      expect(res2.content[0].text).toContain('Component: Button');
      await server.close();
    });

    it('does not corrupt session root on failed or unknown tool calls', async () => {
      setLastKnownProjectRoot(tempDir);
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      // Unknown tool
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'non_existent_tool',
          arguments: {},
        },
      });
      expect(getLastKnownProjectRoot()).toBe(tempDir);

      // Failed tool call (non-existent file)
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: { path: 'NonExistent.vue' },
        },
      });
      expect(getLastKnownProjectRoot()).toBe(tempDir);
      await server.close();
    });
  });

  describe('SERVE-03: Workspace-directed telemetry recording', () => {
    it('records tool telemetry into target project workspace .strata, not daemon cwd', async () => {
      const projectA = join(tempDir, 'projectA');
      const projectB = join(tempDir, 'projectB');
      mkdirSync(join(projectA, '.strata'), { recursive: true });
      mkdirSync(join(projectB, '.strata'), { recursive: true });
      writeFileSync(join(projectB, 'package.json'), '{}');
      writeFileSync(
        join(projectB, 'Card.vue'),
        '<script setup>\ndefineProps({ label: String })\n</script>\n<template><div>{{ label }}</div></template>'
      );

      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: { path: join(projectB, 'Card.vue') },
        },
      });

      const logPathB = join(projectB, '.strata', 'strata.log');
      const logPathA = join(projectA, '.strata', 'strata.log');

      expect(existsSync(logPathB)).toBe(true);
      const contentB = readFileSync(logPathB, 'utf8');
      expect(contentB).toContain('inspect_component');
      expect(existsSync(logPathA)).toBe(false);
      await server.close();
    });
  });

  describe('SERVE-04: Accurate semantic items_found extraction', () => {
    it('correctly calculates items_found for find_code JSON and text responses', () => {
      const jsonRes = {
        content: [{ type: 'text', text: JSON.stringify({ matchCount: 3, matches: [1, 2, 3] }) }],
      };
      expect(extractItemsFound('find_code', {}, jsonRes)).toBe(3);

      const emptyJsonRes = {
        content: [{ type: 'text', text: JSON.stringify({ matchCount: 0, matches: [] }) }],
      };
      expect(extractItemsFound('find_code', {}, emptyJsonRes)).toBe(0);

      const textRes = {
        content: [{ type: 'text', text: 'file.ts:1:1 - foo\nfile.ts:2:1 - bar' }],
      };
      expect(extractItemsFound('find_code', {}, textRes)).toBe(2);

      const noMatchesRes = {
        content: [{ type: 'text', text: 'No matches found.' }],
      };
      expect(extractItemsFound('find_code', {}, noMatchesRes)).toBe(0);

      const astDumpRes = {
        content: [{ type: 'text', text: 'Program\n  FunctionDeclaration' }],
      };
      expect(extractItemsFound('find_code', { action: 'dump_ast' }, astDumpRes)).toBeUndefined();
    });

    it('records non-zero items_found in telemetry for find_code', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      mkdirSync(join(tempDir, '.strata'), { recursive: true });
      const res = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            mode: 'literal',
            code: 'const x = 1;',
            pattern: 'const',
            format: 'json',
            root: tempDir,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const logFile = join(tempDir, '.strata', 'strata.log');
      expect(existsSync(logFile)).toBe(true);
      const logLine = readFileSync(logFile, 'utf8');
      const parsedLog = JSON.parse(logLine.trim().split('\n').pop()!);
      expect(parsedLog.metrics?.items_found).toBe(1);
      await server.close();
    });
  });

  describe('SERVE-02: Recoverable transport parse error handling', () => {
    it('returns JSON-RPC parse error (-32700) and allows subsequent valid request to execute', async () => {
      const { PassThrough } = await import('node:stream');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const transport = new StdioServerTransport(stdin as any, stdout as any);
      const server = createMcpServer();

      let stdoutData = '';
      stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      transport.onerror = (err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        transport.send({
          jsonrpc: '2.0',
          error: { code: -32700, message: `Parse error: ${errorMsg}` },
          id: null,
        } as any).catch(() => {});
      };

      await server.connect(transport);

      // Send malformed JSON
      stdin.write('{bad json}\n');
      await new Promise((r) => setTimeout(r, 50));

      expect(stdoutData).toContain('-32700');
      expect(stdoutData).toContain('Parse error');

      // Now send valid ping
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }) + '\n');
      await new Promise((r) => setTimeout(r, 50));

      expect(stdoutData).toContain('"id":42');
      await server.close();
    });
  });

  describe('SERVE-05: Error diagnosis recorded in telemetry', () => {
    it('records error diagnosis when tool returns isError: true', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      mkdirSync(join(tempDir, '.strata'), { recursive: true });
      const res = await callHandler({
        method: 'tools/call',
        params: {
          name: 'inspect_component',
          arguments: {
            path: join(tempDir, 'Missing.vue'),
            root: tempDir,
          },
        },
      });

      expect(res.isError).toBe(true);
      const logFile = join(tempDir, '.strata', 'strata.log');
      expect(existsSync(logFile)).toBe(true);
      const logLine = readFileSync(logFile, 'utf8');
      const parsedLog = JSON.parse(logLine.trim().split('\n').pop()!);
      expect(parsedLog.status).toBe('error');
      expect(parsedLog.event).toBe('tool_call_failed');
      expect(parsedLog.error).toBeDefined();
      expect(parsedLog.error.code).toBe('HANDLER_ERROR');
      expect(parsedLog.error.message).toContain('Component file not found');
      await server.close();
    });
  });
});
