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
  _meta?: Record<string, unknown>;
};

export const STRATA_EXPLORER_UI_URI = 'ui://strata/explorer.html';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MAX_BYTES_PROPERTY = {
  type: 'integer',
  minimum: 512,
  description: 'Optional maximum UTF-8 response byte budget (defaults to 16384). Increase when retrying after BUDGET_RESPONSE_TOO_LARGE.',
} as const;

export const V2_TOOL_CATALOG: readonly StrataToolSpec[] = [
  {
    name: 'map_workspace',
    description:
      'Start here to orient in a frontend workspace or monorepo without reading file bodies. Returns package topology, frameworks, routes, file inventory, or unused component candidates (and opens the Strata Explorer UI when supported).',
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: {
      ui: {
        resourceUri: STRATA_EXPLORER_UI_URI,
        visibility: ['model', 'app'],
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Strata Explorer' },
          { type: 'global', title: 'Strata' },
        ],
      },
    },
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
          description:
            'View to return: "overview" (packages + totals), "packages" (monorepo topology), "routes" (pages & API routes), "files" (file list), or "health" (unused component candidates).',
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
        max_bytes: MAX_BYTES_PROPERTY,
      },
    },
  },
  {
    name: 'inspect_file',
    description:
      'Inspect a file or component outline, TypeChecker-resolved props/emits/slots contract, rendered children, outbound HTTP calls (with backendTargetHint), and imports without reading implementation bodies. Returns symbol_id and source_ref handles.',
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
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
        max_bytes: MAX_BYTES_PROPERTY,
      },
    },
  },
  {
    name: 'query_graph',
    description:
      'Trace code relationships across files and monorepo packages: definition, references, call_hierarchy, component_tree, state_flow, and refactor impact sites. Check OMISSIONS (e.g. dynamic spreads) for sites requiring manual verification.',
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
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
        max_bytes: MAX_BYTES_PROPERTY,
      },
    },
  },
  {
    name: 'read_slice',
    description:
      'Read a bounded, hash-verified source slice. Prefer source_ref or symbol_id from inspect_file, query_graph, or search_code; or pass path with symbol, block, or lines.',
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
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
        max_bytes: MAX_BYTES_PROPERTY,
      },
    },
  },
  {
    name: 'search_code',
    description:
      'Search symbols, component template usages, prop/event usages, or literal text across the workspace or a package. Returns symbol_id and source_ref handles for query_graph and read_slice.',
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
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
          description:
            'Search mode: "symbol" (declarations), "component_usage" (template renders), "prop_usage" (prop/event bindings), or "text" (literal substring).',
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
        max_bytes: MAX_BYTES_PROPERTY,
      },
    },
  },
];
