import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Metadata only: importing the MCP catalog must not load analysis engines.
export const TOOL_CATALOG: Array<Tool & { description: string }> = [
{
name: 'find_code',
description:
    'Searches workspace code using AST patterns (ast-grep), relational YAML rules, or component adoption across .vue, .astro, and .tsx. For inspecting a single known component or file, use inspect_component instead.',
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
      rule_yaml: {
        type: 'string',
        description: 'Complete ast-grep YAML rule definition',
      },
      code: {
        type: 'string',
        description: 'Code snippet to test pattern/rule against in-memory, or dump CST syntax tree (alias: code_snippet)',
      },
      action: {
        type: 'string',
        enum: ['search', 'dump_ast'],
        description: 'Action: "search" (default) or "dump_ast" to inspect CST syntax tree',
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
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of directory names or paths to ignore during traversal (e.g. ["storage", "legacy"])',
      },
    },
  }
},
{
name: 'inspect_component',
description:
    'Deep component inspection (.vue, .tsx, .jsx, .astro). Extracts interface contracts (props/emits/slots), layout structure & dynamic classes (:class, Tailwind layout tokens, v-show/v-if), data fetching boundaries (Inertia, TanStack Query, Axios endpoints & backend target hints), form schemas, and reactivity smells.',
inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target component or file path (e.g. "src/components/MyButton.vue", alias: file_path, target_path)',
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
    },
  }
},
{
name: 'audit_frontend',
description:
    'Architectural frontend health audit: file-based routes, dead components, unused state composables, structural template similarity, design tokens & a11y, bundle health / island hydration, outbound API contracts & callers, and page archetype structural drift. Supports targeted or full audits (target: "all").',
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
          'Audit target: "routes" (URL topology), "dead-components" (orphan components), "dead-state" (unused composables/stores), "similar-templates" (redundant template structure & DRY opportunities), "design-tokens" (arbitrary Tailwind colors/spacing, radius consistency & a11y violations), "bundle-health" (heavy eager imports & eager island hydration), "api-contracts" (outbound API endpoints & caller mapping), "archetype-drift" (page semantic section & component drift vs exemplar), or "all" for a full architectural diagnostic (default: "all")',
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
    },
  }
},
{
name: 'generate_patch_plan',
description:
    'Prescriptive Refactoring: Generates precise AST-level patch recommendations (file, line, column, oldSnippet, newSnippet) across all upward consumer components when refactoring, renaming, or removing props and events.',
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
    },
    required: ['path', 'refactor_type', 'old_name'],
  }
}
];
