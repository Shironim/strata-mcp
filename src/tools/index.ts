import { findCodeTool } from './find-code';
import { inspectComponentTool } from './inspect-component';
import { componentTreeTool } from './component-tree';
import { traceStateTool } from './trace-state';
import { auditFrontendTool } from './audit-frontend';
import { patchPlanTool } from './patch-plan';
import { getRoutesTool } from './get-routes';
import { getApiContractsTool } from './get-api-contracts';
import type { McpToolDefinition } from './types';

export * from './types';
export { findCodeTool } from './find-code';
export { inspectComponentTool } from './inspect-component';
export { componentTreeTool } from './component-tree';
export { traceStateTool } from './trace-state';
export { auditFrontendTool } from './audit-frontend';
export { patchPlanTool } from './patch-plan';
export { getRoutesTool } from './get-routes';
export { getApiContractsTool } from './get-api-contracts';

export const TOOLS: McpToolDefinition[] = [
  findCodeTool,
  inspectComponentTool,
  componentTreeTool,
  traceStateTool,
  auditFrontendTool,
  patchPlanTool,
  getRoutesTool,
  getApiContractsTool,
];

const toolsMap = new Map<string, McpToolDefinition>(
  TOOLS.map((tool) => [tool.name, tool])
);

export function findTool(name: string): McpToolDefinition | undefined {
  return toolsMap.get(name);
}
