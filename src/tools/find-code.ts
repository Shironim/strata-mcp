import { TOOL_CATALOG } from './catalog';
import {
  findCode,
  findLiteralCode,
  matchLiteralLines,
  findCodeByRule,
  findComponentUsage,
  formatMatchesAsText,
} from '../engine/search';
import { dumpSyntaxTree, executeAstGrep, isPatternParseError } from '../engine/astgrep';
import { mapFrontendScope } from '../engine/frontend-map';
import {
  parseSafePositiveInt,
  parseStringList,
  resolveProjectRoot,
  resolveWorkspacePath,
} from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import { checkRuntimeVersion, getCachedRuntimeVersion } from '../utils/version-check';

export const findCodeTool: McpToolDefinition = {
  ...TOOL_CATALOG[0],
  handler: async (args: Record<string, any>) => {
    const isJson = args.format === 'json' || args.output_format === 'json';
    const codeSnippet = (args.code || args.code_snippet) ? String(args.code || args.code_snippet) : undefined;
    const rawTargetPath = (args.path || args.file_path || args.filePath || args.target_path || args.targetPath)
      ? String(args.path || args.file_path || args.filePath || args.target_path || args.targetPath)
      : undefined;
    const pattern = (args.pattern || args.query || args.search)
      ? String(args.pattern || args.query || args.search)
      : undefined;
    const language = args.language ? String(args.language) : undefined;

    const mode = args.mode ?? 'ast';
    if (!['ast', 'auto', 'literal'].includes(mode) ||
        (mode !== 'ast' && (!pattern || args.rule_yaml || args.component || args.component_name || args.componentName || args.action === 'dump_ast'))) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid mode: auto/literal require a pattern search, not YAML, component search, or dump_ast.' }] };
    }
    let modeUsed = mode === 'literal' ? 'literal' : 'ast';
    let fallbackReason: string | undefined;
    const metadata = () => ({ modeRequested: mode, modeUsed, ...(fallbackReason ? { fallbackReason } : {}) });
    const notice = () => fallbackReason ? '[Notice: Invalid AST pattern; used exact literal line search.]\n' : '';

    if (args.action === 'map') {
      if (pattern || args.rule_yaml || codeSnippet || args.component || args.component_name || args.componentName || args.mode) {
        return { isError: true, content: [{ type: 'text', text: "'action: map' accepts a path, limit, offset, and exclude_dirs only." }] };
      }
      try {
        const targetPath = rawTargetPath ? resolveWorkspacePath(rawTargetPath) : resolveProjectRoot();
        const result = await mapFrontendScope(targetPath, {
          limit: parseSafePositiveInt(args.limit ?? args.max_results ?? args.maxResults, 100),
          offset: Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0,
          excludeDirs: parseStringList(args.exclude_dirs ?? args.excludeDirs),
        });
        const runtimeVersion = getCachedRuntimeVersion();
        void checkRuntimeVersion().catch(() => {});
        const payload = { runtime_version: runtimeVersion, ...result };
        let textOutput = isJson ? JSON.stringify(payload, null, 2) : formatFrontendMap(result);
        if (!isJson && runtimeVersion.update_available) {
          textOutput = `[Notice: Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Run: ${runtimeVersion.upgrade_command}]\n\n` + textOutput;
        }
        return {
          content: [{ type: 'text', text: textOutput }],
          metadata: { runtime_version: runtimeVersion },
          runtime_version: runtimeVersion,
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Failed to map frontend scope: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }

    // Mode A: dump_ast
    if (args.action === 'dump_ast' || (!rawTargetPath && codeSnippet && !pattern && !args.rule_yaml)) {
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

    try {
      // Mode B: In-memory test of pattern or rule
      if (codeSnippet && (args.rule_yaml || pattern)) {
        let rawMatches;
        if (mode === 'literal') {
          rawMatches = matchLiteralLines(codeSnippet, pattern!);
        } else {
          try {
            rawMatches = await executeAstGrep({ pattern, rule: args.rule_yaml, code: codeSnippet, language: language || 'ts' });
          } catch (err) {
            if (mode !== 'auto' || !isPatternParseError(err)) throw err;
            modeUsed = 'literal';
            fallbackReason = 'invalid_ast_pattern';
            rawMatches = matchLiteralLines(codeSnippet, pattern!);
          }
        }
        rawMatches = rawMatches.slice(0, parseSafePositiveInt(args.max_results ?? args.maxResults, 200));
        const result = {
          matchCount: rawMatches.length,
          matches: rawMatches,
        };
        return {
          content: [{ type: 'text', text: isJson ? JSON.stringify(result, null, 2)
            : notice() + formatMatchesAsText(rawMatches.map(match => ({
              ...match, file: '<snippet>', snippet: match.text,
            }))) }],
          ...(args.rule_yaml ? {} : { structuredContent: metadata() }),
        };
      }

      // Resolve target directory or file with ergonomic fallback to active root
      const targetPath = rawTargetPath ? resolveWorkspacePath(rawTargetPath) : resolveProjectRoot();

      const excludeDirs = parseStringList(args.exclude_dirs ?? args.excludeDirs);
      const maxResults = parseSafePositiveInt(args.max_results ?? args.maxResults);

      // Mode C: Component usage search
      const componentName = args.component || args.component_name || args.componentName;
      if (componentName) {
        const matches = await findComponentUsage({
          componentName: String(componentName),
          targetPath,
          scope: args.scope as any,
          maxResults,
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
          maxResults,
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
      if (pattern) {
        const options = { pattern, targetPath, language, maxResults, excludeDirs };
        let matches;
        if (mode === 'literal') {
          matches = await findLiteralCode(options);
        } else {
          try {
            // Validate explicit modes before keyword pruning can skip every source file.
            if (args.mode) await executeAstGrep({ pattern, code: '', language: language || 'auto' });
            matches = await findCode(options);
          } catch (err) {
            if (mode !== 'auto' || !isPatternParseError(err)) throw err;
            modeUsed = 'literal';
            fallbackReason = 'invalid_ast_pattern';
            matches = await findLiteralCode(options);
          }
        }
        return {
          structuredContent: metadata(),
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : notice() + formatMatchesAsText(matches),
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to execute code search: ${msg}` }],
      };
    }
  },
};

function formatFrontendMap(result: Awaited<ReturnType<typeof mapFrontendScope>>): string {
  return [
    `Frontend map: ${result.root}`,
    `Status: ${result.status}; ${result.coverage.returnedFiles}/${result.coverage.knownFiles} files returned (offset ${result.coverage.offset})`,
    `Framework candidates: ${result.frameworkCandidates.map(item => item.name).join(', ') || 'unknown'} (${result.frameworkDetection})`,
    ...result.files.map(file => `- ${file.path}${file.roleHint ? ` [${file.roleHint}; heuristic]` : ''}`),
    `Extension coverage: ${Object.entries(result.coverage.extensions).filter(([, count]) => count > 0).map(([ext, count]) => `${ext}=${count}`).join(', ') || 'none'}`,
  ].join('\n');
}
