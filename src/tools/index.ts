import { findCodeTool } from './find-code';
import { inspectComponentTool } from './inspect-component';
import { componentTreeTool } from './component-tree';
import { traceStateTool } from './trace-state';
import { auditFrontendTool } from './audit-frontend';
import type { McpToolDefinition } from './types';

export * from './types';
export { findCodeTool } from './find-code';
export { inspectComponentTool } from './inspect-component';
export { componentTreeTool } from './component-tree';
export { traceStateTool } from './trace-state';
export { auditFrontendTool } from './audit-frontend';

export const TOOLS: McpToolDefinition[] = [
  findCodeTool,
  inspectComponentTool,
  componentTreeTool,
  traceStateTool,
  auditFrontendTool,
];

const toolsMap = new Map<string, McpToolDefinition>(
  TOOLS.map((tool) => [tool.name, tool])
);

export function findTool(name: string): McpToolDefinition | undefined {
  return toolsMap.get(name);
}
