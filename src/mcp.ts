#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, findTool } from './tools';
import { AnalysisSupervisor } from './analysis-supervisor';
import { STRATA_INSTRUCTIONS } from './instructions';
import { STRATA_VERSION } from './version';
import { StrataTelemetry } from './engine/telemetry';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from './engine/path-resolver';

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
  const hasSeparateScanRoot = toolName === 'get_component_tree' || toolName === 'generate_patch_plan';
  const targetAlias = args.target_path || args.targetPath;
  const legacyTargetFile = hasSeparateScanRoot && /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(targetAlias || ''));

  // 1. Canonical Entity Aliasing: path
  if (!args.path) {
    const pathAlias =
      args.file_path ||
      args.filePath ||
      (!hasSeparateScanRoot && targetAlias) ||
      args.file ||
      args.entry_path ||
      args.entryPath ||
      args.component_path ||
      args.componentPath ||
      (legacyTargetFile && targetAlias);
    if (pathAlias) {
      args.path = String(pathAlias);
    }
  }

  // Bi-directional alias sync: populate legacy targetPath/target_path/entry_path/component_path from canonical path
  if (hasSeparateScanRoot) {
    if (legacyTargetFile) {
      delete args.target_path;
      delete args.targetPath;
    } else if (targetAlias) {
      args.target_path = targetAlias;
      args.targetPath = targetAlias;
    }
  }
  if (args.path) {
    if (!hasSeparateScanRoot) {
      if (!args.targetPath) args.targetPath = args.path;
      if (!args.target_path) args.target_path = args.path;
    }
    if (!args.entry_path && toolName === 'get_component_tree' && /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(args.path))) args.entry_path = args.path;
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
    if (symbolAlias && toolName !== 'audit_frontend') {
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

/**
 * Extracts the semantic count of items found by a tool.
 * Returns undefined if the tool or mode has no applicable item count concept.
 */
export function extractItemsFound(
  toolName: string,
  args: Record<string, unknown>,
  response: any
): number | undefined {
  if (response?.isError) {
    return 0;
  }
  const firstText = response?.content?.[0]?.text;
  if (typeof firstText !== 'string' || !firstText.trim()) {
    return undefined;
  }

  // Check if response is structured JSON
  if (firstText.trim().startsWith('{') || firstText.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(firstText);
      if (typeof parsed.matchCount === 'number') {
        return parsed.matchCount;
      }
      if (Array.isArray(parsed.matches)) {
        return parsed.matches.length;
      }
      if (parsed.found === false) {
        return 0;
      }
      if (parsed.found === true && parsed.data !== undefined) {
        if (Array.isArray(parsed.data)) return parsed.data.length;
        return 1;
      }
      if (typeof parsed.totalItems === 'number') return parsed.totalItems;
      if (typeof parsed.totalRoutes === 'number') return parsed.totalRoutes;
      if (typeof parsed.totalComponents === 'number') return parsed.totalComponents;
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      // not JSON, fallback to tool-specific regex
    }
  }

  switch (toolName) {
    case 'find_code': {
      if (args.action === 'dump_ast') {
        return undefined;
      }
      if (firstText.includes('No matches found.')) {
        return 0;
      }
      const lines = firstText.trim().split('\n').filter(l => l.trim().length > 0);
      return lines.length;
    }

    case 'inspect_component': {
      if (
        firstText.includes('Component file not found') ||
        firstText.includes('not found') ||
        firstText.includes('"found": false')
      ) {
        return 0;
      }
      return 1;
    }

    case 'get_component_tree': {
      const exploredMatch = firstText.match(/Summary:\s*(\d+)\s*components explored/i);
      if (exploredMatch) return Number(exploredMatch[1]);
      if (firstText.includes('No component hierarchy found')) return 0;
      return undefined;
    }

    case 'trace_state': {
      const match =
        firstText.match(/Total Dependent Components\/(?:Pages|Files):\s*(\d+)/i) ||
        firstText.match(/Total Unique Dependents:\s*(\d+)/i);
      if (match) return Number(match[1]);
      if (firstText.includes('No dependent files found')) return 0;
      return undefined;
    }

    case 'audit_frontend': {
      const unusedMatch = firstText.match(/Unused Components Found:\s*(\d+)/i);
      if (unusedMatch) return Number(unusedMatch[1]);
      const routesMatch = firstText.match(/Total Routes:\s*(\d+)/i);
      if (routesMatch) return Number(routesMatch[1]);
      const clusterMatch = firstText.match(/Clusters Found:\s*(\d+)/i);
      if (clusterMatch) return Number(clusterMatch[1]);
      return undefined;
    }

    case 'generate_patch_plan': {
      const match = firstText.match(/Total Patches Required:\s*(\d+)/i);
      if (match) return Number(match[1]);
      return undefined;
    }

    default:
      return undefined;
  }
}

export function createMcpServer(): Server {
  const runner = new AnalysisSupervisor();
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<any> => {
    const name = request.params.name;
    const rawArgs = request.params.arguments;
    const args = coerceToolArguments(name, rawArgs);
    const startTime = performance.now();
    const tool = findTool(name);

    // Capture explicit per-request root and determine request root hint without polluting global state early
    const explicitRoot = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
    const requestRootHint = explicitRoot ?? getLastKnownProjectRoot();

    const traceId = args.trace_id || args.traceId ? String(args.trace_id || args.traceId) : undefined;
    const sessionId = args.session_id || args.sessionId ? String(args.session_id || args.sessionId) : undefined;

    if (!tool) {
      const errorMsg = `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
      const fallbackRoot = explicitRoot ?? getLastKnownProjectRoot() ?? process.cwd();
      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startTime),
        input: args,
        status: 'error',
        error: { code: 'UNKNOWN_TOOL', message: errorMsg },
      }, fallbackRoot);
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
      const response = await runner.run(name, args, requestRootHint, extra?.signal);
      const durationMs = Math.round(performance.now() - startTime);

      // Session continuity: maintain last known root on successful execution
      if (!response?.isError) {
        if (explicitRoot) {
          setLastKnownProjectRoot(explicitRoot);
        } else if (response?.projectRoot) {
          setLastKnownProjectRoot(response.projectRoot);
        }
      }

      const effectiveRoot = response?.projectRoot ?? explicitRoot ?? requestRootHint ?? process.cwd();

      let bytesOut = 0;
      let linesOut = 0;

      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === 'string') {
            bytesOut += Buffer.byteLength(item.text, 'utf8');
            linesOut += item.text.split('\n').length;
          }
        }
      }

      const itemsFound = extractItemsFound(name, args, response);
      const isHandlerError = Boolean(response?.isError);
      let handlerErrorDiagnosis: { code: string; message: string } | undefined;

      if (isHandlerError) {
        let firstLine = '';
        if (Array.isArray(response.content)) {
          const firstText = response.content.find((c: any) => typeof c.text === 'string')?.text;
          if (firstText) {
            firstLine = firstText.trim().split('\n')[0].slice(0, 256);
          }
        }
        handlerErrorDiagnosis = {
          code: 'HANDLER_ERROR',
          message: firstLine || 'Tool returned error status',
        };
      }

      StrataTelemetry.recordToolCall({
        event: isHandlerError ? 'tool_call_failed' : 'tool_call_completed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: durationMs,
        input: args,
        metrics: {
          bytes_out: bytesOut,
          lines_out: linesOut,
          ...(itemsFound !== undefined ? { items_found: itemsFound } : {}),
        },
        status: isHandlerError ? 'error' : 'success',
        error: handlerErrorDiagnosis,
      }, effectiveRoot);

      // Strip internal worker metadata before returning to client
      const { projectRoot: _workerRoot, ...cleanResponse } = response;
      return cleanResponse;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));
      const errorCode = (errorInstance.message.match(/^([A-Z_]+):/) || [])[1] || 'EXECUTION_ERROR';
      const effectiveRoot = explicitRoot ?? requestRootHint ?? process.cwd();

      StrataTelemetry.recordToolCall({
        event: 'tool_call_failed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: durationMs,
        input: args,
        status: 'error',
        error: {
          code: errorCode,
          message: errorInstance.message.slice(0, 384),
          stack: errorInstance.stack,
        },
      }, effectiveRoot);

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

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await runner.close();
    try {
      const { closeAllDatabases } = await import('./engine/storage/schema');
      closeAllDatabases();
    } catch {
      // ignore
    }
    await originalClose();
  };
  return server;
}

export async function runServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  let isShuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      await server.close();
    } catch {
      // Ignore server close errors during shutdown
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.stdin.on('close', () => void shutdown('stdin:close', 0));

  transport.onclose = () => void shutdown('transport:close', 0);
  server.onclose = () => void shutdown('server:close', 0);

  transport.onerror = (err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Fatal transport errors: buffer overflow, fatal OS stream errors
    const isFatal =
      errorMsg.includes('ReadBuffer exceeded maximum size') ||
      (err instanceof Error && 'code' in err && ['EPIPE', 'ECONNRESET', 'EIO'].includes((err as any).code));

    if (isFatal) {
      process.stderr.write(`[strata] Fatal transport error (${errorMsg}). Shutting down.\n`);
      void shutdown('transport:fatal_error', 1);
      return;
    }

    // Recoverable parse/validation error: client sent malformed JSON
    process.stderr.write(`[strata] Recoverable parse error: ${errorMsg}\n`);
    transport.send({
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: `Parse error: ${errorMsg}`,
      },
      id: null,
    } as any).catch(() => {});
  };

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
    import('./cli').then(({ main }) => main(argv)).catch((err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    });
  } else if (process.stdin.isTTY) {
    import('./cli').then(({ main }) => main([])).catch((err) => {
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

