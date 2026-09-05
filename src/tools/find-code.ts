import {
  findCode,
  findCodeByRule,
  findComponentUsage,
  formatMatchesAsText,
} from '../engine/search';
import { dumpSyntaxTree, executeAstGrep } from '../engine/astgrep';
import { resolveWorkspacePath, resolveProjectRoot } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const findCodeTool: McpToolDefinition = {
  name: 'find_code',
  description:
    'Searches workspace code using AST patterns (ast-grep), relational YAML rules, or component adoption across .vue, .astro, and .tsx. For inspecting a single known component or file, use inspect_component instead.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target directory or file path to search (alias: target_path)',
      },
      target_path: {
        type: 'string',
        description: 'Alias for path',
      },
      pattern: {
        type: 'string',
        description: 'ast-grep pattern (e.g. "console.log($$$)", "ref($$$)")',
      },
      component: {
        type: 'string',
        description: 'Component name to search (e.g. "OldButton" or "old-button")',
      },
      component_name: {
        type: 'string',
        description: 'Alias for component',
      },
      rule_yaml: {
        type: 'string',
        description: 'Complete ast-grep YAML rule definition',
      },
      code: {
        type: 'string',
        description: 'Code snippet to test pattern/rule against in-memory, or dump CST syntax tree',
      },
      code_snippet: {
        type: 'string',
        description: 'Alias for code',
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
          'Language or framework parser hint (auto, vue, astro, ts, js, tsx, jsx, html, css). Automatically routes .vue/.astro script blocks to ts/js and template blocks to html — default: "auto"',
      },
      scope: {
        type: 'string',
        enum: ['template', 'script', 'both'],
        description: 'Scope for component search: "template", "script", or "both" (default: "both")',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format (default: "text" for token efficiency)',
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
  },
  handler: async (args: Record<string, any>) => {
    const isJson = args.output_format === 'json';
    const codeSnippet = (args.code || args.code_snippet) ? String(args.code || args.code_snippet) : undefined;
    const rawTargetPath = (args.path || args.target_path) ? String(args.path || args.target_path) : undefined;
    const language = args.language ? String(args.language) : undefined;

    // Mode A: dump_ast
    if (args.action === 'dump_ast' || (!rawTargetPath && codeSnippet && !args.pattern && !args.rule_yaml)) {
      if (!codeSnippet) {
        return {
          isError: true,
          content: [{ type: 'text', text: "Missing required argument 'code' to dump syntax tree." }],
        };
      }
      const tree = await dumpSyntaxTree(codeSnippet, language || 'ts');
      return {
        content: [{ type: 'text', text: isJson ? JSON.stringify({ tree }, null, 2) : tree }],
      };
    }

    // Mode B: In-memory test of pattern or rule
    if (codeSnippet && (args.rule_yaml || args.pattern)) {
      const rawMatches = await executeAstGrep({
        pattern: args.pattern ? String(args.pattern) : undefined,
        rule: args.rule_yaml ? String(args.rule_yaml) : undefined,
        code: codeSnippet,
        language: language || 'ts',
      });
      const result = {
        matchCount: rawMatches.length,
        matches: rawMatches,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    // Resolve target directory or file with ergonomic fallback to active root
    const targetPath = rawTargetPath ? resolveWorkspacePath(rawTargetPath) : resolveProjectRoot();

    const excludeDirs = Array.isArray(args.exclude_dirs)
      ? args.exclude_dirs.map(String)
      : typeof args.exclude_dirs === 'string'
        ? (args.exclude_dirs as string).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    // Mode C: Component usage search
    const componentName = args.component || args.component_name;
    if (componentName) {
      const matches = await findComponentUsage({
        componentName: String(componentName),
        targetPath,
        scope: args.scope as any,
        maxResults: args.max_results ? Number(args.max_results) : undefined,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
          },
        ],
      };
    }

    // Mode D: YAML rule search
    if (args.rule_yaml) {
      const matches = await findCodeByRule({
        rule: String(args.rule_yaml),
        targetPath,
        maxResults: args.max_results ? Number(args.max_results) : undefined,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
          },
        ],
      };
    }

    // Mode E: Pattern search
    if (args.pattern) {
      const matches = await findCode({
        pattern: String(args.pattern),
        targetPath,
        language,
        maxResults: args.max_results ? Number(args.max_results) : undefined,
        excludeDirs,
      });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: "Please provide 'pattern', 'component', 'rule_yaml', or 'code' to search or test.",
        },
      ],
    };
  },
};
