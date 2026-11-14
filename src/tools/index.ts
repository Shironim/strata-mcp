import { TOOL_CATALOG, type ToolName } from './catalog';
import type { McpToolDefinition } from './types';
export * from './types';

const loaders: Record<ToolName, () => Promise<McpToolDefinition>> = {
  find_code: async () => (await import('./find-code')).findCodeTool,
  inspect_component: async () => (await import('./inspect-component')).inspectComponentTool,
  get_component_tree: async () => (await import('./component-tree')).componentTreeTool,
  trace_state: async () => (await import('./trace-state')).traceStateTool,
  audit_frontend: async () => (await import('./audit-frontend')).auditFrontendTool,
  generate_patch_plan: async () => (await import('./patch-plan')).patchPlanTool,
};

export const TOOLS: McpToolDefinition[] = TOOL_CATALOG.map(tool => ({
  ...tool, handler: async args => (await loaders[tool.name]()).handler(args),
}));

export const findCodeTool = findTool('find_code')!;
export const inspectComponentTool = findTool('inspect_component')!;
export const componentTreeTool = findTool('get_component_tree')!;
export const traceStateTool = findTool('trace_state')!;
export const auditFrontendTool = findTool('audit_frontend')!;
export const patchPlanTool = findTool('generate_patch_plan')!;

export function findTool(name: string): McpToolDefinition | undefined {
  return TOOLS.find(tool => tool.name === name);
}
