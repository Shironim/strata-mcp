import {
  inspectFile,
  mapWorkspace,
  queryGraph,
  readSlice,
  searchCode,
  type CodeSearchKind,
  type GraphDirection,
  type GraphQueryKind,
  type InspectSection,
  type SourceBlockKind,
  type WorkspaceMapView,
} from '../../engine/v2';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from '../../engine/path-resolver';
import type { McpToolDefinition, ToolCallResponse } from '../types';
import { V2_TOOL_CATALOG, type StrataToolName } from './catalog';
import {
  buildEnvelopeResponse,
  formatCodeSearchText,
  formatFileInspectionText,
  formatGraphQueryText,
  formatSourceSliceText,
  formatToolError,
  formatWorkspaceMapText,
} from './formatter';

function resolveRoot(args: Record<string, unknown>): string {
  const explicit = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
  const root = explicit ?? getLastKnownProjectRoot() ?? process.cwd();
  setLastKnownProjectRoot(root);
  return root;
}

function resolveFormat(args: Record<string, unknown>): 'text' | 'json' {
  return args.format === 'json' ? 'json' : 'text';
}

const QUERY_KIND_MAP: Record<string, GraphQueryKind> = {
  definition: 'definition',
  references: 'references',
  call_hierarchy: 'callHierarchy',
  callHierarchy: 'callHierarchy',
  component_tree: 'componentTree',
  componentTree: 'componentTree',
  state_flow: 'stateFlow',
  stateFlow: 'stateFlow',
  impact: 'impact',
};

const SEARCH_KIND_MAP: Record<string, CodeSearchKind> = {
  symbol: 'symbol',
  component_usage: 'componentUsage',
  componentUsage: 'componentUsage',
  prop_usage: 'propUsage',
  propUsage: 'propUsage',
  text: 'text',
};

async function handleMapWorkspace(args: Record<string, unknown>): Promise<ToolCallResponse> {
  try {
    const workspaceRoot = resolveRoot(args);
    const format = resolveFormat(args);
    const env = await mapWorkspace({
      workspaceRoot,
      view: (args.view as WorkspaceMapView | undefined) ?? 'overview',
      packageKey: typeof args.package === 'string' ? args.package : undefined,
      pathPrefix: typeof args.path_prefix === 'string' ? args.path_prefix : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
    });
    return buildEnvelopeResponse(env, format, formatWorkspaceMapText);
  } catch (err) {
    return formatToolError(err);
  }
}

async function handleInspectFile(args: Record<string, unknown>): Promise<ToolCallResponse> {
  try {
    const workspaceRoot = resolveRoot(args);
    const format = resolveFormat(args);
    const env = await inspectFile({
      workspaceRoot,
      path: String(args.path ?? ''),
      sections: Array.isArray(args.sections) ? (args.sections as InspectSection[]) : undefined,
      resolveTypes: typeof args.resolve_types === 'boolean' ? args.resolve_types : true,
    });
    return buildEnvelopeResponse(env, format, formatFileInspectionText);
  } catch (err) {
    return formatToolError(err);
  }
}

async function handleQueryGraph(args: Record<string, unknown>): Promise<ToolCallResponse> {
  try {
    const workspaceRoot = resolveRoot(args);
    const format = resolveFormat(args);
    const rawQuery = String(args.query ?? '');
    const mappedQuery = QUERY_KIND_MAP[rawQuery] ?? (rawQuery as GraphQueryKind);
    const rawTarget = (args.target && typeof args.target === 'object' ? args.target : {}) as Record<string, unknown>;
    const rawScope = (args.scope && typeof args.scope === 'object' ? args.scope : undefined) as
      | Record<string, unknown>
      | undefined;

    const env = await queryGraph({
      workspaceRoot,
      query: mappedQuery,
      target: {
        symbolId: typeof rawTarget.symbol_id === 'string' ? rawTarget.symbol_id : undefined,
        file: typeof rawTarget.file === 'string' ? rawTarget.file : undefined,
        symbol: typeof rawTarget.symbol === 'string' ? rawTarget.symbol : undefined,
        member: typeof rawTarget.member === 'string' ? rawTarget.member : undefined,
        line: typeof rawTarget.line === 'number' ? rawTarget.line : undefined,
        column: typeof rawTarget.column === 'number' ? rawTarget.column : undefined,
      },
      direction: (args.direction as GraphDirection | undefined) ?? undefined,
      scope: rawScope
        ? {
            packages: Array.isArray(rawScope.packages) ? (rawScope.packages as string[]) : undefined,
            maxDepth: typeof rawScope.max_depth === 'number' ? rawScope.max_depth : undefined,
          }
        : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
    });
    return buildEnvelopeResponse(env, format, formatGraphQueryText);
  } catch (err) {
    return formatToolError(err);
  }
}

async function handleReadSlice(args: Record<string, unknown>): Promise<ToolCallResponse> {
  try {
    const workspaceRoot = resolveRoot(args);
    const lines =
      Array.isArray(args.lines) && args.lines.length === 2
        ? ([Number(args.lines[0]), Number(args.lines[1])] as [number, number])
        : undefined;
    const env = await readSlice({
      workspaceRoot,
      sourceRef: typeof args.source_ref === 'string' ? args.source_ref : undefined,
      symbolId: typeof args.symbol_id === 'string' ? args.symbol_id : undefined,
      path: typeof args.path === 'string' ? args.path : undefined,
      symbol: typeof args.symbol === 'string' ? args.symbol : undefined,
      block: typeof args.block === 'string' ? (args.block as SourceBlockKind) : undefined,
      lines,
      contextLines: typeof args.context_lines === 'number' ? args.context_lines : undefined,
      maxLines: typeof args.max_lines === 'number' ? args.max_lines : undefined,
    });
    return buildEnvelopeResponse(env, 'text', formatSourceSliceText);
  } catch (err) {
    return formatToolError(err);
  }
}

async function handleSearchCode(args: Record<string, unknown>): Promise<ToolCallResponse> {
  try {
    const workspaceRoot = resolveRoot(args);
    const format = resolveFormat(args);
    const rawKind = typeof args.kind === 'string' ? args.kind : 'symbol';
    const mappedKind = SEARCH_KIND_MAP[rawKind] ?? (rawKind as CodeSearchKind);
    const env = await searchCode({
      workspaceRoot,
      query: String(args.query ?? ''),
      kind: mappedKind,
      symbolKinds: Array.isArray(args.symbol_kinds) ? (args.symbol_kinds as string[]) : undefined,
      packageKey: typeof args.package === 'string' ? args.package : undefined,
      pathPrefix: typeof args.path_prefix === 'string' ? args.path_prefix : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
    });
    return buildEnvelopeResponse(env, format, formatCodeSearchText);
  } catch (err) {
    return formatToolError(err);
  }
}

const HANDLER_MAP: Record<StrataToolName, (args: Record<string, unknown>) => Promise<ToolCallResponse>> = {
  map_workspace: handleMapWorkspace,
  inspect_file: handleInspectFile,
  query_graph: handleQueryGraph,
  read_slice: handleReadSlice,
  search_code: handleSearchCode,
};

export const V2_TOOLS: McpToolDefinition[] = V2_TOOL_CATALOG.map((spec) => ({
  ...spec,
  handler: HANDLER_MAP[spec.name],
}));

export function findV2Tool(name: string): McpToolDefinition | undefined {
  return V2_TOOLS.find((tool) => tool.name === name);
}
