import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type StrataToolName =
  | 'map_workspace'
  | 'inspect_file'
  | 'query_graph'
  | 'read_slice'
  | 'search_code';

export type StrataToolSpec = Tool & {
  name: StrataToolName;
  description: string;
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const V2_TOOL_CATALOG: readonly StrataToolSpec[] = [
  {
    name: 'map_workspace',
    description:
      'Orient in a frontend workspace or monorepo before reading files. Returns package topology, frameworks, routes, file inventory, or static health candidates without file bodies.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Workspace root directory (optional if already established in session).',
        },
        view: {
          type: 'string',
          enum: ['overview', 'packages', 'routes', 'files', 'health'],
          default: 'overview',
          description: 'Orientation view to render.',
        },
        package: {
          type: 'string',
          description: 'Filter to a single monorepo package key (e.g. "apps/web", "packages/ui").',
        },
        path_prefix: {
          type: 'string',
          description: 'Optional relative directory prefix filter for view="files".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 100,
          description: 'Maximum items returned per page.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned by a previous call.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          default: 'text',
          description: 'Output format (compact text by default).',
        },
      },
    },
  },
  {
    name: 'inspect_file',
    description:
      'Inspect a frontend file or component outline, TypeChecker-resolved props/slots contract, render boundary, outbound HTTP boundaries, and imports without reading implementation bodies.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the target file (.vue, .tsx, .jsx, .svelte, .astro, .ts, .js).',
        },
        root: {
          type: 'string',
          description: 'Optional workspace root directory.',
        },
        sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['outline', 'contract', 'boundaries', 'imports'],
          },
          description: 'Sections to include (default: ["outline", "contract", "boundaries"]).',
        },
        resolve_types: {
          type: 'boolean',
          default: true,
          description: 'Use TypeScript TypeChecker for external prop expansion and 1-hop composable boundary tracing.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          default: 'text',
          description: 'Output format (compact text by default).',
        },
      },
    },
  },
  {
    name: 'query_graph',
    description:
      'Query code relationships and impact across files and monorepo packages: go-to-definition, find-all-references, call hierarchy, component tree, state flow, and refactor impact sites (with dynamic omissions).',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query', 'target'],
      properties: {
        query: {
          type: 'string',
          enum: [
            'definition',
            'references',
            'call_hierarchy',
            'component_tree',
            'state_flow',
            'impact',
          ],
          description: 'Relationship query to run.',
        },
        target: {
          type: 'object',
          additionalProperties: false,
          description: 'Target symbol, file, member, or source position.',
          properties: {
            symbol_id: { type: 'string', description: 'Stable symbolId handle from inspect_file or search_code.' },
            file: { type: 'string', description: 'Absolute or workspace-relative file path.' },
            symbol: { type: 'string', description: 'Symbol or state identifier name.' },
            member: { type: 'string', description: 'Component prop, event, slot, or object member name.' },
            line: { type: 'integer', minimum: 1, description: '1-based line number.' },
            column: { type: 'integer', minimum: 1, description: '1-based column number.' },
          },
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'both'],
          default: 'up',
          description: 'Traversal direction for call_hierarchy or component_tree.',
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            packages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Limit traversal/verification to specific monorepo package keys.',
            },
            max_depth: {
              type: 'integer',
              minimum: 1,
              maximum: 8,
              default: 4,
              description: 'Maximum traversal depth.',
            },
          },
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 30,
          description: 'Maximum items returned per page.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned by a previous call.',
        },
        root: {
          type: 'string',
          description: 'Optional workspace root directory.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          default: 'text',
          description: 'Output format (compact text by default).',
        },
      },
    },
  },
  {
    name: 'read_slice',
    description:
      'Read a bounded, hash-verified source code slice by source_ref handle, symbol_id, symbol name, SFC block, or explicit line range.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source_ref: {
          type: 'string',
          description: 'Hash-verified sourceRef handle from inspect_file, query_graph, or search_code.',
        },
        symbol_id: {
          type: 'string',
          description: 'Stable symbolId handle to read its exact implementation body.',
        },
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path (used with symbol, block, or lines).',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name inside path.',
        },
        block: {
          type: 'string',
          enum: ['script', 'scriptSetup', 'template', 'style'],
          description: 'SFC block to read.',
        },
        lines: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 2,
          maxItems: 2,
          description: 'Explicit 1-based inclusive [startLine, endLine] range.',
        },
        context_lines: {
          type: 'integer',
          minimum: 0,
          maximum: 20,
          default: 2,
          description: 'Extra surrounding context lines.',
        },
        max_lines: {
          type: 'integer',
          minimum: 1,
          maximum: 400,
          default: 80,
          description: 'Maximum lines returned in one slice.',
        },
        root: {
          type: 'string',
          description: 'Optional workspace root directory.',
        },
      },
    },
  },
  {
    name: 'search_code',
    description:
      'Discover symbols, component usages, prop/event usages, or scoped literal text across the workspace or a specific monorepo package. Returns symbol_id and source_ref handles.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name, component name, prop/event name, or literal text to search for.',
        },
        kind: {
          type: 'string',
          enum: ['symbol', 'component_usage', 'prop_usage', 'text'],
          default: 'symbol',
          description: 'Search mode.',
        },
        symbol_kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter for kind="symbol" (e.g. ["component", "store", "composable", "function"]).',
        },
        package: {
          type: 'string',
          description: 'Filter to a single monorepo package key.',
        },
        path_prefix: {
          type: 'string',
          description: 'Optional relative directory prefix filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 30,
          description: 'Maximum matches returned per page.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned by a previous call.',
        },
        root: {
          type: 'string',
          description: 'Optional workspace root directory.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          default: 'text',
          description: 'Output format (compact text by default).',
        },
      },
    },
  },
];
