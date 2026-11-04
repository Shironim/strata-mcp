import { TOOL_CATALOG } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { hashRetrievalIdentity } from '../engine/retrieval-evidence';
import { findProjectRoot } from '../engine/path-resolver';
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
import { findByComponentProp } from '../engine/search-intent';
import {
  parseSafePositiveInt,
  parseStringList,
  resolveProjectRoot,
  resolveWorkspacePath,
} from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import { checkRuntimeVersion, getCachedRuntimeVersion } from '../utils/version-check';

const findCodeToolDefinition: McpToolDefinition = {
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

    const rawPropName = args.prop_name ?? args.prop ?? args.propName;
    const rawPropPresence = args.prop_presence ?? args.propPresence;
    if (rawPropName !== undefined || rawPropPresence !== undefined) {
      if ((args.action && args.action !== 'search') || ['pattern', 'query', 'search', 'code', 'code_snippet', 'rule_yaml',
        'mode', 'language', 'scope', 'limit', 'offset', 'max_results', 'maxResults', 'exclude_dirs', 'excludeDirs'].some(key => args[key] !== undefined)) {
        return { isError: true, content: [{ type: 'text', text: 'PROP_SELECTOR_CONFLICT: use component + prop_name (+ optional prop_presence) with path and format/budget only; remove pattern, code, rule_yaml, mode, scope and other actions.' }] };
      }
      const rawComponent = args.component ?? args.component_name ?? args.componentName;
      try {
        const result = await findByComponentProp(
          { component: rawComponent, prop: rawPropName, presence: rawPropPresence },
          rawTargetPath ? resolveWorkspacePath(rawTargetPath) : resolveProjectRoot()
        );
        return { structuredContent: result, content: [{ type: 'text', text: isJson ? JSON.stringify(result, null, 2)
          : `Prop query: ${JSON.stringify(result.query)}\n${formatMatchesAsText(result.matches)}\nProp supply coverage: ${JSON.stringify(result.coverage.propSupply)}\nPartial static search: review candidates and coverage before concluding absence.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    }

    if (pattern !== undefined && pattern.trim().length === 0 && !args.rule_yaml && !args.component && args.action !== 'map' && args.action !== 'dump_ast') {
      return { isError: true, content: [{ type: 'text', text: 'Pattern cannot be empty or whitespace only.' }] };
    }

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
      if (pattern || args.rule_yaml || codeSnippet || args.component || args.component_name || args.componentName || (args.mode && args.mode !== 'ast')) {
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
          structuredContent: payload,
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
          structuredContent: { ...result, ...(args.rule_yaml ? {} : metadata()) },
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
        const isTruncated = Boolean(maxResults && matches.length >= maxResults);
        const coverage = maxResults ? { truncated: isTruncated, limit: maxResults, returned: matches.length } : undefined;
        return {
          structuredContent: { matches, matchCount: matches.length, ...(coverage ? { coverage, truncated: isTruncated } : {}) },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches) + (isTruncated ? `\n\n[Notice: Results truncated at max_results=${maxResults}. Gunakan parameter path/scope yang lebih spesifik atau sesuaikan max_results untuk melihat match lainnya.]` : ''),
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
        const isTruncated = Boolean(maxResults && matches.length >= maxResults);
        const coverage = maxResults ? { truncated: isTruncated, limit: maxResults, returned: matches.length } : undefined;
        return {
          structuredContent: { matches, matchCount: matches.length, ...(coverage ? { coverage, truncated: isTruncated } : {}) },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : formatMatchesAsText(matches) + (isTruncated ? `\n\n[Notice: Results truncated at max_results=${maxResults}. Gunakan parameter path/scope yang lebih spesifik atau sesuaikan max_results untuk melihat match lainnya.]` : ''),
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
            // Validate AST modes before keyword pruning can skip every source file.
            if (mode === 'ast' || mode === 'auto') await executeAstGrep({ pattern, code: '', language: language || 'auto' });
            matches = await findCode(options);
          } catch (err) {
            if (mode !== 'auto' || !isPatternParseError(err)) throw err;
            modeUsed = 'literal';
            fallbackReason = 'invalid_ast_pattern';
            matches = await findLiteralCode(options);
          }
        }
        const isTruncated = Boolean(maxResults && matches.length >= maxResults);
        const coverage = maxResults ? { truncated: isTruncated, limit: maxResults, returned: matches.length } : undefined;
        return {
          structuredContent: { ...metadata(), matches, matchCount: matches.length, ...(coverage ? { coverage, truncated: isTruncated } : {}) },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(matches, null, 2) : notice() + formatMatchesAsText(matches) + (isTruncated ? `\n\n[Notice: Results truncated at max_results=${maxResults}. Gunakan parameter path/scope yang lebih spesifik atau sesuaikan max_results untuk melihat match lainnya.]` : ''),
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

export const findCodeTool: McpToolDefinition = withRetrievalEvidence(findCodeToolDefinition, args => {
  const snippet = (args.code || args.code_snippet) ? String(args.code || args.code_snippet) : undefined;
  const rawPath = args.path || args.file_path || args.filePath || args.target_path || args.targetPath;
  const scope = snippet ? null : rawPath ? resolveWorkspacePath(String(rawPath)) : resolveProjectRoot();
  const pattern = args.pattern || args.query || args.search;
  const component = args.component || args.component_name || args.componentName;
  const propName = args.prop_name ?? args.prop ?? args.propName;
  const propPresence = args.prop_presence ?? args.propPresence;
  const action = args.action === 'map' ? 'map' : args.action === 'dump_ast' || (!rawPath && snippet && !pattern && !args.rule_yaml) ? 'dump_ast' : 'search';
  return {
    workspace: scope ? findProjectRoot(scope) : null, scope, policy: `find-code-${action}-v1`,
    ...(snippet ? { inputHash: hashRetrievalIdentity({ encoding: 'utf-8', content: snippet }) } : {}),
    query: { action, pattern: pattern ? String(pattern) : null, component: component ? String(component) : null,
      propName: propName !== undefined ? String(propName) : null,
      propPresence: propName !== undefined || propPresence !== undefined ? String(propPresence ?? 'present') : null,
      rule: args.rule_yaml ? String(args.rule_yaml) : null, language: args.language ?? (snippet ? 'ts' : null),
      mode: pattern ? args.mode ?? 'ast' : null, componentScope: component && propName === undefined ? args.scope ?? 'both' : null,
      limit: action === 'map' ? Math.min(500, parseSafePositiveInt(args.limit ?? args.max_results ?? args.maxResults, 100)!) : parseSafePositiveInt(args.max_results ?? args.maxResults, snippet ? 200 : undefined) ?? null,
      offset: action === 'map' && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0,
      excludeDirs: parseStringList(args.exclude_dirs ?? args.excludeDirs) },
  };
});

function formatFrontendMap(result: Awaited<ReturnType<typeof mapFrontendScope>>): string {
  return [
    `Frontend map: ${result.root}`,
    `Status: ${result.status}; ${result.coverage.returnedFiles}/${result.coverage.knownFiles} files returned (offset ${result.coverage.offset})`,
    `Framework candidates: ${result.frameworkCandidates.map(item => item.name).join(', ') || 'unknown'} (${result.frameworkDetection})`,
    ...result.files.map(file => `- ${file.path}${file.roleHint ? ` [${file.roleHint}; heuristic]` : ''}`),
    `Extension coverage: ${Object.entries(result.coverage.extensions).filter(([, count]) => count > 0).map(([ext, count]) => `${ext}=${count}`).join(', ') || 'none'}`,
  ].join('\n');
}
