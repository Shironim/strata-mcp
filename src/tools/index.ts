import { TOOL_CATALOG } from './catalog';
import type { McpToolDefinition } from './types';
export * from './types';

async function loadTool(index: number): Promise<McpToolDefinition> {
  switch (index) {
    case 0: return (await import('./find-code')).findCodeTool;
    case 1: return (await import('./inspect-component')).inspectComponentTool;
    case 2: return (await import('./component-tree')).componentTreeTool;
    case 3: return (await import('./trace-state')).traceStateTool;
    case 4: return (await import('./audit-frontend')).auditFrontendTool;
    case 5: return (await import('./patch-plan')).patchPlanTool;
    default: throw new Error('Unknown tool index');
  }
}

export const TOOLS: McpToolDefinition[] = TOOL_CATALOG.map((tool, index) => ({
  ...tool, handler: async args => (await loadTool(index)).handler(args),
}));

export const findCodeTool = TOOLS[0];
export const inspectComponentTool = TOOLS[1];
export const componentTreeTool = TOOLS[2];
export const traceStateTool = TOOLS[3];
export const auditFrontendTool = TOOLS[4];
export const patchPlanTool = TOOLS[5];

export function findTool(name: string): McpToolDefinition | undefined {
  return TOOLS.find(tool => tool.name === name);
}
