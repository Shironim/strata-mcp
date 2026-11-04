import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Metadata only: importing the MCP catalog must not load analysis engines.
export const TOOL_CATALOG: Array<Tool & { description: string }> = [
{
name: 'find_code',
description:
    'Maps a bounded frontend inventory or searches workspace code using AST patterns (ast-grep), relational YAML rules, or component adoption across .vue, .astro, .tsx, .jsx, .ts, and .js. For inspecting one file and retrieving exact source slices, use inspect_component.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target directory or file path to search (alias: file_path, target_path)',
      },
      pattern: {
        type: 'string',
        description: 'AST pattern (e.g. "console.log($$$)", "ref($$$)"). For exact text use mode: literal; auto falls back only on AST pattern parse errors. Alias: query, search',
      },
      mode: {
        type: 'string',
        enum: ['ast', 'auto', 'literal'],
        description: 'Pattern search mode: ast (default, structural matching), literal (exact case-sensitive substring per line, no regex), auto (AST with literal fallback on pattern parse errors only). Applies to pattern searches, including code snippets.',
      },
      component: {
        type: 'string',
        description: 'Component name to search (e.g. "OldButton" or "old-button", alias: component_name)',
      },
      prop_name: {
        type: 'string',
        description: 'Prop name to analyze across Vue component usages or omissions (requires component, e.g. "title"; alias: prop). Requires an unambiguous exact component basename in path scope. Returns usages or resolved static render omissions plus indeterminate supply counts.',
      },
      prop_presence: {
        type: 'string',
        enum: ['present', 'omitted'],
        description: 'Filter for component + prop_name search: "present" (default, renders supplying the prop) or "omitted" (resolved static renders omitting the prop without dynamic forwarding).',
      },
      rule_yaml: {
        type: 'string',
        description: 'Complete ast-grep YAML rule definition',
      },
      code: {
        type: 'string',
        description: 'Code snippet to test pattern/rule against in-memory (alias: code_snippet)',
      },
      action: {
        type: 'string',
        enum: ['search', 'map'],
        description: 'Action: search (default) or map a bounded frontend file inventory without reading file bodies.',
      },
      language: {
        type: 'string',
        enum: ['auto', 'vue', 'astro', 'ts', 'js', 'tsx', 'jsx', 'html', 'css'],
        description:
          'Parser hint. Disk searches infer languages from source files and Vue/Astro blocks. Snippet pattern searches and CST dumps default to ts; specify tsx/jsx/html for those syntaxes. Explicit auto uses a tag heuristic, not full language detection. YAML rules specify their own language.',
      },
      scope: {
        type: 'string',
        enum: ['template', 'script', 'both'],
        description: 'Scope for component search: "template", "script", or "both" (default: "both")',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format (default: "text" for token efficiency, alias: output_format)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum matches to return (default: 200)',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum inventory file paths returned for action: map (default: 100).' },
      offset: { type: 'integer', minimum: 0, description: 'Stable zero-based inventory offset for action: map.' },
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names or paths to ignore during traversal (e.g. ["storage", "legacy"])',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
  }
},
{
name: 'inspect_component',
description:
    'Component and module inspector for frontend source (.vue, .astro, .svelte, .tsx, .jsx, .ts, .js). Extracts public component contracts (props, emits, slots, state, outbound APIs), maps source structure and outline without code bodies (view: "map" or outline: true), and slices targeted symbols with callers (symbol: "name" or source_range) for precise inspection without dumping entire files.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target component or file path (e.g. "src/components/MyButton.vue", alias: file_path, target_path)',
      },
      view: {
        type: 'string',
        enum: ['map', 'source'],
        description: 'Map exact source regions or retrieve a source slice by a source_ref from the map.',
      },
      source_ref: {
        type: 'object',
        properties: {
          sha256: { type: 'string' },
          startOffset: { type: 'integer', minimum: 0 },
          endOffset: { type: 'integer', minimum: 0 },
        },
        required: ['sha256', 'startOffset', 'endOffset'],
        description: 'Exact hash-bound UTF-16 source reference returned by view: map.',
      },
      max_regions: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum top-level map regions returned (default: 200).' },
      sfc_sections: {
        type: 'boolean',
        description: 'For Vue SFC files, return exact content boundaries for each <script>, <template>, <style>, and custom block.',
      },
      source_range: {
        type: 'object',
        properties: {
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['start_line', 'end_line'],
        description: 'Return the original file lines from start_line through end_line, inclusive, with verified line numbers.',
      },
      expected_hash: {
        type: 'string',
        description: 'Optional SHA-256 from an earlier map; rejects stale inclusive source_range requests.',
      },
      project_root: {
        type: 'string',
        description: 'Explicit project directory for resolving paths and searching missing-file candidates. Does not require a project marker.',
      },
      symbol: {
        type: 'string',
        description:
          'Symbol/function name to slice verbatim with exact line numbers, callers, and covering test detection (e.g. "calculateTotal", "handleSubmit", alias: symbol_name)',
      },
      audit_events: {
        type: 'boolean',
        description:
          'When true on Vue components, audits template-to-script reactivity integrity for broken and dead event handlers',
      },
      infer_props: {
        type: 'boolean',
        description:
          'When true (default), deeply infers object prop sub-properties (.data, .links, etc.) and data shapes from template and script AST',
      },
      impact: {
        type: 'string', enum: ['none', 'summary', 'full'],
        description: 'Optional contract-only per-prop impact scan (default none). Vue static template consumer counts, usage counts, static render omissions, candidates and rename/remove risk per prop. summary omits locations; full includes hash-bound usage/omission refs. Scope uses project_root; for component-level hierarchy across pages, use get_component_tree(direction: "upward").',
      },
      resolve_globals: {
        type: 'boolean',
        description:
          'When true (default), identifies un-imported global symbols, Ziggy route() helpers, and auto-imported composables',
      },
      outline: {
        type: 'boolean',
        description:
          'When true, extracts full symbol outline of all functions, methods, and computed properties with exact line ranges, cross-file callee targets, and complexity smells (alias: include_outline)',
      },
      max_function_lines: {
        type: 'number',
        description:
          'Line count threshold for high-complexity warning (default: 300)',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
  }
},
{
name: 'get_component_tree',
description:
    'Resolves component hierarchy trees from a root file or URL route (e.g. "/dashboard"). Supports downward trees with props drilling (>2 levels) and dangling context alerts (provide/inject & useContext), or upward traversal for blast radius.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Root component file path to inspect (e.g. "src/App.vue", alias: entry_path, file_path)',
      },
      route: {
        type: 'string',
        description: 'URL route path to resolve directly to page entrypoint and tree (e.g. "/dashboard", "/catalog/[id]", alias: route_path)',
      },
      target_path: {
        type: 'string',
        description: 'Project root directory (default: ".", alias: root, workspace_root)',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 3, alias: depth)',
      },
      direction: {
        type: 'string',
        enum: ['downward', 'upward', 'down', 'up'],
        description:
          'Traversal direction: "downward" / "down" (root -> children) or "upward" / "up" (leaf -> consumers/pages blast radius). Default: "downward".',
      },
      alias_map: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Optional alias map overriding auto-detected jsconfig/tsconfig paths (e.g. { "@/": "resources/js/" })',
      },
      scope_filter: {
        type: 'string',
        description: 'Optional package/domain scope filter (e.g. "apps/web", "features/auth", alias: scope_path)',
      },
      include_props: {
        type: 'boolean',
        description:
          'When true (default), displays props and data bindings passed down to child components [props: childProp <- parentExpr]',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text (indented tree) or json (default: "text", alias: output_format)',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
  }
},
{
name: 'trace_state',
description:
    'Traces state store (Pinia/Zustand/Redux), Context, or composable impact across frontend components. Identifies where state is modified, read, or called. Supports shallow impact (depth: 1) as well as multi-hop cascading dependency chains (depth: 2+).',
inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'State identifier to trace (e.g. "useCartStore", "useRouter", alias: state, store, composable)',
      },
      path: {
        type: 'string',
        description: 'Project root directory or component file path (default: ".", alias: target_path, file_path)',
      },
      depth: {
        type: 'number',
        description: 'Traversal depth: 1 for direct consumers impact, or >1 for multi-hop call chain (default: 1, alias: max_depth)',
      },
      role: {
        type: 'string',
        enum: ['all', 'mutators', 'readers'],
        description:
          'Consumer role filter: "all" (grouped into mutators and readers), "mutators" (only triggers/action callers), or "readers" (only state/render consumers). Default: "all"',
      },
      direction: {
        type: 'string',
        enum: ['consumers', 'dependencies', 'both'],
        description: 'Direction for multi-hop tracing (default: "both")',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
  }
},
{
name: 'audit_frontend',
description:
    'Maps frontend architecture topology (routes, api-contracts) and runs structural health audits (dead-components, dead-state, design-tokens, bundle-health, similar-templates, archetype-drift). Use target: "routes" or "api-contracts" when discovering pages, layouts, and endpoints for new or changed features; use health targets or target: "all" for diagnostics.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project root directory or target page file for archetype-drift (alias: target_path, default: ".")',
      },
      target_path: {
        type: 'string',
        description: 'Alias for path',
      },
      exemplar_path: {
        type: 'string',
        description:
          'Optional exemplar/reference page file path for target: "archetype-drift" (auto-discovers richest sibling page when omitted)',
      },
      scope_path: {
        type: 'string',
        description:
          'Sub-directory or workspace scope filter within target_path (e.g. "apps/web") to avoid scanning entire monorepos and prevent cold-start timeouts',
      },
      target: {
        type: 'string',
        enum: [
          'routes',
          'dead-components',
          'dead-state',
          'similar-templates',
          'design-tokens',
          'bundle-health',
          'api-contracts',
          'archetype-drift',
          'all',
        ],
        description:
          'Audit target: "routes" (URL topology), "dead-components" (orphan components), "dead-state" (unused composables/stores), "similar-templates" (redundant template structure & DRY opportunities), "design-tokens" (arbitrary Tailwind colors/spacing, radius consistency & a11y violations), "bundle-health" (heavy eager imports & eager island hydration), "api-contracts" (outbound API endpoints & caller mapping), "archetype-drift" (page semantic section & component drift vs exemplar), or "all" for a full architectural diagnostic (default: "all", excluding similar-templates and archetype-drift)',
      },
      threshold: {
        type: 'number',
        description: 'Similarity threshold for template redundancy audit between 0.0 and 1.0 (default: 0.8)',
      },
      view: {
        type: 'string',
        enum: ['summary', 'full', 'tree'],
        description: 'Route display for target routes (default: summary); also applies to routes in target all.',
      },
      prefix: {
        type: 'string',
        description: 'Optional URL prefix filter for route scanner (e.g. "/api", "/auth")',
      },
      framework: {
        type: 'string',
        enum: ['next-app', 'next-pages', 'nuxt', 'astro', 'inertia', 'vue-router', 'unknown'],
        description: 'Optional framework hint for route scanner',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to exclude from dead component audit',
      },
      include_pages: {
        type: 'boolean',
        description: 'Include page/view files in dead-components audit (default: false)',
      },
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names or paths to ignore during traversal',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
  }
},
{
name: 'generate_patch_plan',
description:
    'Component contract consumer refactoring: generates precise AST-level patch plans (file, line, column, oldSnippet, newSnippet, sourceRef) across upward consumer components when renaming or removing a component prop, event, v-model, or slot.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the component file being refactored (e.g. "src/components/Button.vue", alias: component_path, file_path)',
      },
      refactor_type: {
        type: 'string',
        enum: [
          'rename_prop',
          'remove_prop',
          'rename_event',
          'remove_event',
          'rename_model',
          'remove_model',
          'rename_slot',
          'remove_slot',
        ],
        description: 'The type of refactoring operation being performed (prop, event, model, or slot)',
      },
      old_name: {
        type: 'string',
        description: 'Current prop, model, slot, or event name (e.g. "is-active", "title", "header", "on-click")',
      },
      new_name: {
        type: 'string',
        description: 'New prop or event name (required when renaming, e.g. "variant", "active")',
      },
      target_path: {
        type: 'string',
        description: 'Workspace or project root directory (default: ".")',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
      max_bytes: {
        type: 'integer',
        minimum: 512,
        description: 'Hard limit for the full UTF-8 JSON tool result, including metadata and content/structuredContent duplication; excludes JSON-RPC framing. Pages one selected collection, or returns an explicit budget error when atomic data/metadata cannot fit. Minimum 512 bytes permits a compact error, not every successful result.',
      },
      continuation_token: {
        type: 'string',
        description: 'Deterministic continuation token from a previous truncated retrieval to fetch the next page.',
      },
    },
    required: ['path', 'refactor_type', 'old_name'],
  }
}
];

const routing: Record<string, { alternative: string; example: Record<string, unknown> }> = {
  find_code: { alternative: 'Use inspect_component for the contract or exact source of one file.', example: { path: 'src', component: 'Button', scope: 'template' } },
  inspect_component: { alternative: 'Use impact: summary|full for per-prop usage/omission risk, or get_component_tree(direction: upward) for component-level consumer hierarchy across pages.', example: { path: 'src/Button.vue', view: 'map' } },
  get_component_tree: { alternative: 'Use generate_patch_plan for operation-specific edits; static traversal may be partial.', example: { path: 'src/Button.vue', direction: 'upward' } },
  trace_state: { alternative: 'Use inspect_component for a single-file interface; this tool does not prove runtime state behavior.', example: { path: 'src', identifier: 'useCartStore', role: 'readers' } },
  audit_frontend: { alternative: 'Use target: routes or api-contracts to discover pages and endpoints for new features; use inspect_component for one component. Diagnostics do not certify browser or business behavior.', example: { path: '.', target: 'routes' } },
  generate_patch_plan: { alternative: 'Use inspect_component to understand the target contract first. Plans cover supported static consumer usages, not every dynamic reference, and do not apply edits.', example: { path: 'src/Button.vue', target_path: '.', refactor_type: 'rename_prop', old_name: 'label', new_name: 'heading' } },
};

for (const tool of TOOL_CATALOG) {
  tool.inputSchema.properties ??= {};
  tool.inputSchema.properties.response_detail = { type: 'string', enum: ['summary', 'full'], default: 'summary',
    description: 'Explicit layered output: summary (recommended default for initial discovery) returns counts/previews and preserves evidence, risks and diagnostics; repeat the original request with full for primary analysis or exact source slices. Summary is not a continuation page or exact source.' };
  const guide = routing[tool.name]!;
  tool.description += ` ${guide.alternative} Example input: ${JSON.stringify(guide.example)}. Analysis does not modify application source; internal cache/index and telemetry may be updated.`;
  tool.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}
