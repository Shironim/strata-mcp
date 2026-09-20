#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { verifyAstGrepBinary } from './engine/astgrep';
import { TOOLS, findTool } from './tools';
import { main as runCli } from './cli';
import { STRATA_INSTRUCTIONS } from './instructions';
import { STRATA_VERSION } from './version';
import { closeAllDatabases, getDatabase } from './engine/database';
import { WorkspaceWatcher } from './engine/watcher';
import { StrataTelemetry } from './engine/telemetry';

export { TOOLS, findTool } from './tools';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'strata-mcp',
      version: STRATA_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: STRATA_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const { name, arguments: args = {} } = request.params;
    const startTime = performance.now();
    const tool = findTool(name);

    if (!tool) {
      const errorMsg = `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        duration_ms: Math.round(performance.now() - startTime),
        input: args,
        status: 'error',
        error: { code: 'UNKNOWN_TOOL', message: errorMsg },
      });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: errorMsg,
          },
        ],
      };
    }

    try {
      const response = await tool.handler(args);
      const durationMs = Math.round(performance.now() - startTime);

      let bytesOut = 0;
      let linesOut = 0;
      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === 'string') {
            bytesOut += Buffer.byteLength(item.text, 'utf8');
            linesOut += item.text.split('\n').length;
          }
        }
      }

      StrataTelemetry.recordToolCall({
        event: 'tool_call_completed',
        tool: name,
        duration_ms: durationMs,
        input: args,
        metrics: { bytes_out: bytesOut, lines_out: linesOut },
        status: response?.isError ? 'error' : 'success',
      });

      return response;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));

      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        duration_ms: durationMs,
        input: args,
        status: 'error',
        error: {
          message: errorInstance.message,
          stack: errorInstance.stack,
        },
      });

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool error (${name}): ${errorInstance.message}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const binaryCheck = await verifyAstGrepBinary();
  if (!binaryCheck.ok) {
    console.error(`[strata-mcp WARNING]: ${binaryCheck.error}`);
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  // Initialize and start in-process background watcher for transparent delta-sync
  let watcher: WorkspaceWatcher | null = null;
  try {
    const db = getDatabase(process.cwd());
    watcher = new WorkspaceWatcher(process.cwd(), db, {
      onError: (err) => {
        process.stderr.write(`[strata-watcher] Warning: ${err.message}\n`);
      },
    });
    watcher.start();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[strata-watcher] Failed to start background watcher: ${msg}\n`);
  }

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher close errors during shutdown
      }
    }

    try {
      await server.close();
    } catch {
      // Ignore server close errors during shutdown
    }

    try {
      closeAllDatabases();
    } catch {
      // Ignore database close errors during shutdown
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.stdin.on('close', () => void gracefulShutdown('stdin:close'));
  process.on('exit', () => {
    closeAllDatabases();
  });

  if (process.stdin.isTTY) {
    process.stderr.write(`[strata] MCP server daemon running on stdio (PID: ${process.pid}).\n`);
    process.stderr.write(`[strata] Listening for JSON-RPC client messages. Press Ctrl+C to stop.\n`);
  }

  await server.connect(transport);
}

// Dual-mode entrypoint:
// - If arguments are passed: delegate entirely to runCli (Single Source of Truth for command routing).
// - If no arguments are passed:
//   - When interactive (TTY): display CLI help instead of hanging on stdin.
//   - When non-interactive (piped stdin, e.g. Claude Desktop / Cursor): launch MCP stdio server.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    runCli(argv).catch((err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    });
  } else if (process.stdin.isTTY) {
    runCli([]).catch((err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    });
  } else {
    runServer().catch((err) => {
      console.error('Fatal MCP Server error:', err);
      process.exit(1);
    });
  }
}

