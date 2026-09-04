import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolCallResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  handler: (args: Record<string, any>) => Promise<ToolCallResponse>;
}
