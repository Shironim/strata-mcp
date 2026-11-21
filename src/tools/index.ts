import type { McpToolDefinition } from './types';
import { V2_TOOLS, findV2Tool } from './v2';

export * from './types';
export * from './v2';

export const TOOLS: McpToolDefinition[] = V2_TOOLS;

export const mapWorkspaceTool = findV2Tool('map_workspace')!;
export const inspectFileTool = findV2Tool('inspect_file')!;
export const queryGraphTool = findV2Tool('query_graph')!;
export const readSliceTool = findV2Tool('read_slice')!;
export const searchCodeTool = findV2Tool('search_code')!;

export function findTool(name: string): McpToolDefinition | undefined {
  return findV2Tool(name);
}
