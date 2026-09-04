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

export { TOOLS, findTool } from './tools';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'strata-mcp',
      version: '0.6.0',
    },
    {
      capabilities: {
        tools: {},
      },
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = findTool(name);

    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
          },
        ],
      };
    }

    try {
      return await tool.handler(args);
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`,
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
  await server.connect(transport);
}

// Dual-mode single-binary entrypoint:
// - If arguments are passed (argv.length > 0), run CLI (subcommands, flags, --version, --help, typo validation).
// - If no arguments are passed (argv.length === 0), run the MCP stdio server.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    runCli(argv).catch((err) => {
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
