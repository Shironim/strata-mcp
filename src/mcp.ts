#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { verifyAstGrepBinary } from './engine/astgrep';
import { TOOLS, findTool } from './tools';
import { main as runCli } from './cli';
import { STRATA_INSTRUCTIONS } from './instructions';
import { STRATA_VERSION } from './version';
import { closeAllDatabases, getDatabase } from './engine/database';
import { StrataTelemetry } from './engine/telemetry';
import { setLastKnownProjectRoot } from './engine/path-resolver';

export { TOOLS, findTool } from './tools';

/**
 * Pillar 1 & 2: Universal Fault-Tolerant Coercion (Single-Arity Coercion)
 * Normalizes bare string arguments and non-standard aliases to canonical tool parameters.
 */
export function coerceToolArguments(toolName: string, rawArgs: any): Record<string, any> {
  if (rawArgs === null || rawArgs === undefined) {
    return {};
  }

  // Single-arity bare string handling
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    switch (toolName) {
      case 'inspect_component':
      case 'get_component_tree':
      case 'audit_frontend':
      case 'get_routes':
      case 'get_api_contracts':
      case 'generate_patch_plan':
        return { path: trimmed };
      case 'find_code':
        return { pattern: trimmed };
      case 'trace_state':
        if (
          trimmed.startsWith('.') ||
          trimmed.startsWith('/') ||
          /\.(vue|tsx|jsx|astro|ts|js)$/i.test(trimmed)
        ) {
          return { path: trimmed };
        }
        return { identifier: trimmed };
      default:
        return { path: trimmed };
    }
  }

  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return {};
  }

  const args: Record<string, any> = { ...rawArgs };

  // 1. Canonical Entity Aliasing: path
  if (!args.path) {
    const pathAlias =
      args.file_path ||
      args.filePath ||
      args.target_path ||
      args.targetPath ||
      args.file ||
      args.entry_path ||
      args.entryPath ||
      args.component_path ||
      args.componentPath;
    if (pathAlias) {
      args.path = String(pathAlias);
    }
  }

  // Bi-directional alias sync: populate legacy targetPath/target_path/entry_path/component_path from canonical path
  if (args.path) {
    if (!args.targetPath) args.targetPath = args.path;
    if (!args.target_path) args.target_path = args.path;
    if (!args.entry_path && toolName === 'get_component_tree') args.entry_path = args.path;
    if (!args.component_path && toolName === 'generate_patch_plan') args.component_path = args.path;
    if (!args.filePath && toolName === 'trace_state') args.filePath = args.path;
  }

  // 2. Canonical Entity Aliasing: format
  if (!args.format) {
    const formatAlias = args.output_format || args.outputFormat;
    if (formatAlias) {
      args.format = String(formatAlias);
    }
  }
  if (!args.output_format && args.format) {
    args.output_format = args.format;
  }

  // 3. Canonical Entity Aliasing: pattern
  if (!args.pattern) {
    const patternAlias = args.query || args.search;
    if (patternAlias) {
      args.pattern = String(patternAlias);
    }
  }

  // 4. Canonical Entity Aliasing: symbol
  if (!args.symbol) {
    const symbolAlias = args.symbol_name || args.symbolName || args.name;
    if (symbolAlias && toolName !== 'get_routes' && toolName !== 'audit_frontend') {
      args.symbol = String(symbolAlias);
    }
  }

  // 5. Canonical Entity Aliasing: identifier (for trace_state)
  if (!args.identifier && toolName === 'trace_state') {
    const idAlias =
      args.state ||
      args.state_name ||
      args.stateName ||
      args.store ||
      args.store_name ||
      args.storeName ||
      args.composable ||
      args.symbol ||
      args.name;
    if (idAlias) {
      args.identifier = String(idAlias);
    }
  }

  // 6. Canonical Entity Aliasing: component
  if (!args.component) {
    const compAlias = args.component_name || args.componentName;
    if (compAlias) {
      args.component = String(compAlias);
    }
  }

  // 7. Canonical Entity Aliasing: root (Pillar 4: Multi-root workspace consistency)
  if (!args.root) {
    const rootAlias =
      args.workspace_root ||
      args.workspaceRoot ||
      args.project_root ||
      args.projectRoot;
    if (rootAlias) {
      args.root = String(rootAlias);
    }
  }
  if (args.root) {
    if (!args.target_path || /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(args.target_path))) {
      args.target_path = args.root;
      args.targetPath = args.root;
    }
  }

  // 8. Canonical Entity Aliasing: exemplar_path (for archetype-drift audit)
  if (!args.exemplar_path) {
    const exemplarAlias = args.exemplar || args.exemplarPath;
    if (exemplarAlias) {
      args.exemplar_path = String(exemplarAlias);
    }
  }

  // 9. Canonical Entity Aliasing for generate_patch_plan
  if (toolName === 'generate_patch_plan') {
    if (!args.refactor_type) {
      const refactorAlias = args.refactor || args.refactorType;
      if (refactorAlias) args.refactor_type = String(refactorAlias);
    }
    if (!args.old_name) {
      const oldAlias = args.old || args.oldName;
      if (oldAlias) args.old_name = String(oldAlias);
    }
    if (!args.new_name) {
      const newAlias = args.new || args.newName;
      if (newAlias) args.new_name = String(newAlias);
    }
  }

  // 10. Canonical Entity Aliasing: framework / framework_hint / frameworkHint
  if (!args.framework && (args.framework_hint || args.frameworkHint)) {
    args.framework = String(args.framework_hint || args.frameworkHint);
  }

  // 11. Canonical Entity Aliasing: scope_path / scope_filter / scopePath / scopeFilter
  const rawScope = args.scope_path ?? args.scopePath ?? args.scope_filter ?? args.scopeFilter;
  if (rawScope !== undefined) {
    if (args.scope_path === undefined) args.scope_path = String(rawScope);
    if (args.scope_filter === undefined) args.scope_filter = String(rawScope);
  }

  // 12. Canonical Entity Aliasing: alias_map / aliasMap / alias
  const rawAliasMap = args.alias_map ?? args.aliasMap ?? args.alias;
  if (rawAliasMap !== undefined) {
    const parsedAliasMap = parseAliasMapInput(rawAliasMap);
    if (parsedAliasMap) {
      args.alias_map = parsedAliasMap;
    } else {
      delete args.alias_map;
      delete args.aliasMap;
      delete args.alias;
    }
  }

  // 13. Canonical Entity Aliasing: exclude_dirs / excludeDirs & ignore_patterns / ignorePatterns
  const rawExcludeDirs = args.exclude_dirs ?? args.excludeDirs;
  if (rawExcludeDirs !== undefined) {
    args.exclude_dirs = parseStringList(rawExcludeDirs);
  }
  const rawIgnorePatterns = args.ignore_patterns ?? args.ignorePatterns;
  if (rawIgnorePatterns !== undefined) {
    args.ignore_patterns = parseStringList(rawIgnorePatterns);
  }

  // 14. Safe numeric parsing & depth normalization
  const parsedDepth = parseSafePositiveInt(args.depth ?? args.max_depth ?? args.maxDepth);
  if (parsedDepth !== undefined) {
    args.depth = parsedDepth;
    args.max_depth = parsedDepth;
  } else {
    delete args.depth;
    delete args.max_depth;
  }

  const rawMaxResults = args.max_results ?? args.maxResults;
  if (rawMaxResults !== undefined) {
    const parsedMaxResults = parseSafePositiveInt(rawMaxResults);
    if (parsedMaxResults !== undefined) {
      args.max_results = parsedMaxResults;
    } else {
      delete args.max_results;
    }
  }

  if (args.threshold !== undefined) {
    const parsedThreshold = parseSafeFloat(args.threshold);
    if (parsedThreshold !== undefined) {
      args.threshold = parsedThreshold;
    } else {
      delete args.threshold;
    }
  }

  return args;
}

export {
  parseSafePositiveInt,
  parseSafeFloat,
  parseStringList,
  parseAliasMapInput,
  normalizeAuditTarget,
  VALID_AUDIT_TARGETS,
} from './engine/path-resolver';
import {
  parseSafePositiveInt,
  parseSafeFloat,
  parseStringList,
  parseAliasMapInput,
} from './engine/path-resolver';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'strata-mcp',
      version: STRATA_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: STRATA_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const name = request.params.name;
    const rawArgs = request.params.arguments;
    const args = coerceToolArguments(name, rawArgs);
    const startTime = performance.now();
    const tool = findTool(name);

    // Multi-root consistency: set last known root if passed
    if (args.root && typeof args.root === 'string') {
      setLastKnownProjectRoot(args.root);
    }


    const traceId = args.trace_id || args.traceId ? String(args.trace_id || args.traceId) : undefined;
    const sessionId = args.session_id || args.sessionId ? String(args.session_id || args.sessionId) : undefined;

    if (!tool) {
      const errorMsg = `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startTime),
        input: args,
        status: 'error',
        error: { code: 'UNKNOWN_TOOL', message: errorMsg },
      });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: errorMsg,
          },
        ],
      };
    }

    try {
      const response = await tool.handler(args);
      const durationMs = Math.round(performance.now() - startTime);

      let bytesOut = 0;
      let linesOut = 0;
      let itemsFound = 0;

      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === 'string') {
            bytesOut += Buffer.byteLength(item.text, 'utf8');
            linesOut += item.text.split('\n').length;

            // Attempt to parse JSON response for precise domain items count
            try {
              const parsed = JSON.parse(item.text);
              if (Array.isArray(parsed)) {
                itemsFound += parsed.length;
              } else if (typeof parsed === 'object' && parsed !== null) {
                if (typeof parsed.totalEndpointsFound === 'number') {
                  itemsFound += parsed.totalEndpointsFound;
                } else if (typeof parsed.totalRoutesFound === 'number') {
                  itemsFound += parsed.totalRoutesFound;
                } else if (typeof parsed.totalFilesAudited === 'number') {
                  itemsFound += parsed.totalFilesAudited;
                } else if (typeof parsed.totalPatches === 'number') {
                  itemsFound += parsed.totalPatches;
                } else if (Array.isArray(parsed.matches)) {
                  itemsFound += parsed.matches.length;
                } else if (Array.isArray(parsed.props)) {
                  itemsFound += parsed.props.length;
                } else if (Array.isArray(parsed.endpoints)) {
                  itemsFound += parsed.endpoints.length;
                } else if (Array.isArray(parsed.routes)) {
                  itemsFound += parsed.routes.length;
                } else if (Array.isArray(parsed.children)) {
                  itemsFound += parsed.children.length;
                }
              }
            } catch {
              // Text output heuristic: count markdown bullet points
              const bulletMatches = item.text.match(/^\s*[-*•]\s+/gm);
              if (bulletMatches) {
                itemsFound += bulletMatches.length;
              }
            }
          }
        }
      }

      StrataTelemetry.recordToolCall({
        event: 'tool_call_completed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: durationMs,
        input: args,
        metrics: { bytes_out: bytesOut, lines_out: linesOut, items_found: itemsFound },
        status: response?.isError ? 'error' : 'success',
      });

      return response;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));

      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: durationMs,
        input: args,
        status: 'error',
        error: {
          message: errorInstance.message,
          stack: errorInstance.stack,
        },
      });

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool error (${name}): ${errorInstance.message}`,
          },
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

  // Initialize workspace database (getDatabase starts transparent background delta-sync watcher)
  try {
    getDatabase(process.cwd());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[strata-watcher] Failed to initialize database: ${msg}\n`);
  }

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      await server.close();
    } catch {
      // Ignore server close errors during shutdown
    }

    try {
      closeAllDatabases();
    } catch {
      // Ignore database close errors during shutdown
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.stdin.on('close', () => void gracefulShutdown('stdin:close'));
  process.on('exit', () => {
    closeAllDatabases();
  });

  if (process.stdin.isTTY) {
    process.stderr.write(`[strata] MCP server daemon running on stdio (PID: ${process.pid}).\n`);
    process.stderr.write(`[strata] Listening for JSON-RPC client messages. Press Ctrl+C to stop.\n`);
  }

  await server.connect(transport);
}

// Dual-mode entrypoint:
// - If arguments are passed: delegate entirely to runCli (Single Source of Truth for command routing).
// - If no arguments are passed:
//   - When interactive (TTY): display CLI help instead of hanging on stdin.
//   - When non-interactive (piped stdin, e.g. Claude Desktop / Cursor): launch MCP stdio server.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    runCli(argv).catch((err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    });
  } else if (process.stdin.isTTY) {
    runCli([]).catch((err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    });
  } else {
    runServer().catch((err) => {
      console.error('Fatal MCP Server error:', err);
      process.exit(1);
    });
  }
}

