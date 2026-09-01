#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  findCode,
  findCodeByRule,
  findComponentUsage,
  formatMatchesAsText,
} from './engine/search';
import { dumpSyntaxTree, executeAstGrep, verifyAstGrepBinary } from './engine/astgrep';
import { extractComponentContract, formatContractAsText } from './engine/contract';
import { getComponentTree, formatTreeAsText } from './engine/tree';
import { findUnusedComponents, formatUnusedAsText } from './engine/audit';
import { scanRoutes, formatRoutesAsText } from './engine/routes';
import { queryStateImpact, formatStateImpactAsText } from './engine/database';
import type { RouteFramework } from './types';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'strata-mcp',
      version: '0.4.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'find_code',
          description:
            'Search code using ast-grep pattern syntax across Vue SFC (.vue), Astro (.astro), and JS/TS/JSX/TSX files with exact line remapping.',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: 'ast-grep pattern (e.g. "console.log($$$)", "ref($$$)")',
              },
              path: {
                type: 'string',
                description: 'Target directory or file path to search',
              },
              language: {
                type: 'string',
                description: 'Language hint (ts, js, tsx, jsx)',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format (default: "text" for token efficiency)',
              },
              max_results: {
                type: 'number',
                description: 'Maximum number of matches to return (default: 200)',
              },
            },
            required: ['pattern', 'path'],
          },
        },
        {
          name: 'find_code_by_rule',
          description:
            'Search code using complex ast-grep YAML rules (relational constraints like inside, has, not) across Vue (.vue), Astro (.astro), and JS/TS files.',
          inputSchema: {
            type: 'object',
            properties: {
              rule_yaml: {
                type: 'string',
                description: 'Complete YAML rule definition',
              },
              path: {
                type: 'string',
                description: 'Target directory or file path',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format (default: "text")',
              },
              max_results: {
                type: 'number',
                description: 'Maximum matches to return',
              },
            },
            required: ['rule_yaml', 'path'],
          },
        },
        {
          name: 'find_component_usage',
          description:
            'High-level audit tool: finds component imports, dynamic imports, barrel re-exports, and usages in Vue templates, Astro templates, and JSX elements with exact line numbers.',
          inputSchema: {
            type: 'object',
            properties: {
              component_name: {
                type: 'string',
                description: 'Component name to search (e.g., "OldButton" or "old-button")',
              },
              path: {
                type: 'string',
                description: 'Target directory or file path',
              },
              scope: {
                type: 'string',
                enum: ['template', 'script', 'both'],
                description: 'Scope of search: "template", "script", or "both" (default: "both")',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format (default: "text")',
              },
              max_results: {
                type: 'number',
                description: 'Maximum matches to return',
              },
            },
            required: ['component_name', 'path'],
          },
        },
        {
          name: 'dump_syntax_tree',
          description: 'Dumps the CST syntax tree of a code snippet for AST pattern debugging.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Code snippet to dump',
              },
              language: {
                type: 'string',
                description: 'Language of the snippet (default: "ts")',
              },
            },
            required: ['code'],
          },
        },
        {
          name: 'test_match_code_rule',
          description: 'Tests an ast-grep YAML rule against an in-memory code snippet without scanning disk.',
          inputSchema: {
            type: 'object',
            properties: {
              rule_yaml: {
                type: 'string',
                description: 'ast-grep YAML rule',
              },
              code_snippet: {
                type: 'string',
                description: 'Code snippet to test against',
              },
              language: {
                type: 'string',
                description: 'Language of code (default: "ts")',
              },
            },
            required: ['rule_yaml', 'code_snippet'],
          },
        },
        {
          name: 'extract_component_contract',
          description:
            'Extracts the public interface contract of a component (props, emits, slots, types) without implementation body across Vue, React, and Astro.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute or relative path to the component file (.vue, .tsx, .jsx, .astro)',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format (default: "text" for token efficiency)',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'get_component_tree',
          description:
            'Resolves the downward component hierarchy tree (call graph / dependency tree) starting from a root page or layout across Vue, React, and Astro.',
          inputSchema: {
            type: 'object',
            properties: {
              entry_path: {
                type: 'string',
                description: 'Path to the root component/page file',
              },
              max_depth: {
                type: 'number',
                description: 'Maximum traversal depth (default: 3)',
              },
              direction: {
                type: 'string',
                enum: ['downward', 'upward'],
                description:
                  'Traversal direction: "downward" (root page -> child components) or "upward" (leaf component -> consumers/pages blast radius). Default: "downward".',
              },
              alias_map: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                  'Optional alias map that overrides/merges with auto-detected jsconfig/tsconfig paths (e.g. { "@/": "resources/js/" }). Keys may use "*" (wildcard) or end with "/" (prefix).',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format: text (indented tree) or json (default: "text")',
              },
            },
            required: ['entry_path'],
          },
        },
        {
          name: 'find_unused_components',
          description:
            'Audits a codebase to find dead or unreferenced components (0 usages across project files).',
          inputSchema: {
            type: 'object',
            properties: {
              target_path: {
                type: 'string',
                description: 'Project root or components directory to audit',
              },
              ignore_patterns: {
                type: 'array',
                items: { type: 'string' },
                description: 'Glob patterns to exclude (e.g. ["**/pages/**", "**/*.stories.*"])',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format: text or json (default: "text")',
              },
            },
            required: ['target_path'],
          },
        },
        {
          name: 'scan_routes',
          description:
            'Discovers file-based route topology (URL routes, dynamic params, layouts, and API handlers) across Next.js (App & Pages), Nuxt 3, Astro, and Inertia.js.',
          inputSchema: {
            type: 'object',
            properties: {
              target_path: {
                type: 'string',
                description: 'Project root directory or pages/app folder to scan (alias: path)',
              },
              path: {
                type: 'string',
                description: 'Alias for target_path',
              },
              framework: {
                type: 'string',
                enum: ['next-app', 'next-pages', 'nuxt', 'astro', 'inertia', 'unknown'],
                description: 'Optional framework hint if auto-detection should be bypassed',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format: text or json (default: "text")',
              },
            },
            required: ['target_path'],
          },
        },
        {
          name: 'query_state_impact',
          description:
            'Queries all components, layout wrappers, and pages consuming a specific state store (Pinia/Zustand/Redux), Context, or custom composable using the SQLite graph cache.',
          inputSchema: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description:
                  'The state identifier to query (e.g. "useCartStore", "ThemeContext", "useRouter")',
              },
              target_path: {
                type: 'string',
                description: 'Project root directory (alias: path, default: ".")',
              },
              path: {
                type: 'string',
                description: 'Alias for target_path',
              },
              output_format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format: text or json (default: "text")',
              },
            },
            required: ['identifier'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === 'find_code') {
        const targetPath = (args.path || args.target_path) ? String(args.path || args.target_path) : '';
        if (!targetPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'path' (or 'target_path')" }],
          };
        }
        if (!args.pattern) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'pattern'" }],
          };
        }
        const matches = await findCode({
          pattern: String(args.pattern),
          targetPath,
          language: args.language ? String(args.language) : undefined,
          maxResults: args.max_results ? Number(args.max_results) : undefined,
        });

        const isJson = args.output_format === 'json';
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
            },
          ],
        };
      }

      if (name === 'find_code_by_rule') {
        const targetPath = (args.path || args.target_path) ? String(args.path || args.target_path) : '';
        if (!targetPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'path' (or 'target_path')" }],
          };
        }
        if (!args.rule_yaml) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'rule_yaml'" }],
          };
        }
        const matches = await findCodeByRule({
          rule: String(args.rule_yaml),
          targetPath,
          maxResults: args.max_results ? Number(args.max_results) : undefined,
        });

        const isJson = args.output_format === 'json';
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
            },
          ],
        };
      }

      if (name === 'find_component_usage') {
        const targetPath = (args.path || args.target_path) ? String(args.path || args.target_path) : '';
        if (!targetPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'path' (or 'target_path')" }],
          };
        }
        if (!args.component_name) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'component_name'" }],
          };
        }
        const matches = await findComponentUsage({
          componentName: String(args.component_name),
          targetPath,
          scope: args.scope as 'template' | 'script' | 'both',
          maxResults: args.max_results ? Number(args.max_results) : undefined,
        });

        const isJson = args.output_format === 'json';
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
            },
          ],
        };
      }

      if (name === 'dump_syntax_tree') {
        if (!args.code) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'code'" }],
          };
        }
        const tree = await dumpSyntaxTree(String(args.code), String(args.language || 'ts'));
        return {
          content: [{ type: 'text', text: tree }],
        };
      }

      if (name === 'test_match_code_rule') {
        if (!args.code_snippet || !args.rule_yaml) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required arguments: 'code_snippet' and 'rule_yaml'" }],
          };
        }
        const rawMatches = await executeAstGrep({
          code: String(args.code_snippet),
          rule: String(args.rule_yaml),
          language: String(args.language || 'ts'),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  matchCount: rawMatches.length,
                  matches: rawMatches,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (name === 'extract_component_contract') {
        const filePath = (args.path || args.target_path || args.file_path)
          ? String(args.path || args.target_path || args.file_path)
          : '';
        if (!filePath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'path'" }],
          };
        }
        const contract = await extractComponentContract(filePath);
        const isJson = args.output_format === 'json';

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(contract, null, 2) : formatContractAsText(contract),
            },
          ],
        };
      }

      if (name === 'get_component_tree') {
        const entryPath = (args.entry_path || args.path || args.target_path)
          ? String(args.entry_path || args.path || args.target_path)
          : '';
        if (!entryPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'entry_path' (or 'path')" }],
          };
        }
        const maxDepth = args.max_depth !== undefined ? Number(args.max_depth) : undefined;
        const direction = args.direction === 'upward' ? 'upward' : 'downward';
        const aliasMap =
          args.alias_map && typeof args.alias_map === 'object'
            ? Object.fromEntries(
                Object.entries(args.alias_map as Record<string, unknown>).map(([key, value]) => [
                  key,
                  String(value),
                ])
              )
            : undefined;
        const result = await getComponentTree({
          entryPath,
          maxDepth,
          direction,
          aliasMap,
        });
        const isJson = args.output_format === 'json';

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatTreeAsText(result),
            },
          ],
        };
      }

      if (name === 'find_unused_components') {
        const targetPath = (args.target_path || args.path)
          ? String(args.target_path || args.path)
          : '';
        if (!targetPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'target_path' (or 'path')" }],
          };
        }
        const ignorePatterns = Array.isArray(args.ignore_patterns)
          ? args.ignore_patterns.map(String)
          : undefined;
        const result = await findUnusedComponents({
          targetPath,
          ignorePatterns,
        });
        const isJson = args.output_format === 'json';

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatUnusedAsText(result),
            },
          ],
        };
      }

      if (name === 'scan_routes') {
        const targetPath = (args.target_path || args.path)
          ? String(args.target_path || args.path)
          : '';
        if (!targetPath) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'target_path' (or 'path')" }],
          };
        }
        const result = await scanRoutes({
          targetPath,
          frameworkHint: args.framework as RouteFramework | undefined,
        });
        const isJson = args.output_format === 'json';

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatRoutesAsText(result),
            },
          ],
        };
      }

      if (name === 'query_state_impact') {
        const identifier = args.identifier ? String(args.identifier) : '';
        if (!identifier) {
          return {
            isError: true,
            content: [{ type: 'text', text: "Missing required argument: 'identifier'" }],
          };
        }
        const targetPath = (args.target_path || args.path)
          ? String(args.target_path || args.path)
          : process.cwd();
        const result = await queryStateImpact(targetPath, identifier);
        const isJson = args.output_format === 'json';

        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatStateImpactAsText(result),
            },
          ],
        };
      }

      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool name: ${name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const binaryCheck = await verifyAstGrepBinary();
  if (!binaryCheck.ok) {
    console.error(`[strata-mcp WARNING]: ${binaryCheck.error}`);
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-run when executed directly
if (import.meta.main) {
  runServer().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
