import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolCallResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolEnvelope<T = any> {
  success: boolean;
  found: boolean;
  data?: T;
  summary?: string;
  error?: string;
  suggestions?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  handler: (args: Record<string, any>) => Promise<ToolCallResponse>;
}

export function createSuccessEnvelope<T>(data: T, summary?: string): ToolCallResponse {
  const envelope: ToolEnvelope<T> = {
    success: true,
    found: true,
    data,
    summary,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}

export function createNotFoundEnvelope(error: string, suggestions?: string[]): ToolCallResponse {
  const envelope: ToolEnvelope = {
    success: true,
    found: false,
    error,
    suggestions: suggestions && suggestions.length > 0 ? suggestions : undefined,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}

export function createErrorEnvelope(error: string, suggestions?: string[]): ToolCallResponse {
  const envelope: ToolEnvelope = {
    success: false,
    found: false,
    error,
    suggestions: suggestions && suggestions.length > 0 ? suggestions : undefined,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}

