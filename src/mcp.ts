#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, findTool } from './tools';
import { toolActionKey } from './tools/catalog';
import { AnalysisSupervisor } from './analysis-supervisor';
import { STRATA_INSTRUCTIONS } from './instructions';
import { STRATA_VERSION } from './version';
import { describeResultSelection } from './tools/result-selection';
import { StrataTelemetry } from './engine/telemetry';
import { enforceResponseLimit } from './engine/context-budget';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from './engine/path-resolver';

export { TOOLS, findTool } from './tools';

import { coerceToolArguments } from './tools/request';
export { coerceToolArguments } from './tools/request';

export {
  parseSafePositiveInt,
  parseStringList,
  parseAliasMapInput,
  normalizeAuditTarget,
  VALID_AUDIT_TARGETS,
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
  const structured = response?.structuredContent;
  if (structured && typeof structured === 'object') {
    const count = describeResultSelection(toolName, args, structured).count;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  }
  const firstText = response?.content?.[0]?.text;
  if (typeof firstText !== 'string' || !firstText.trim()) {
    return undefined;
  }

  // Check if response is structured JSON
  if (firstText.trim().startsWith('{') || firstText.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(firstText);
      if (parsed?.resultSummary || parsed?.decision || args.action === 'map') {
        const count = describeResultSelection(toolName, args, parsed).count;
        return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
      }
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
      tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<any> => {
    const name = request.params.name;
    const rawArgs = request.params.arguments;
    const args = coerceToolArguments(name, rawArgs);
    const startTime = performance.now();
    const tool = findTool(name);
    const actionKey = toolActionKey(name);
    const actionSchema = tool?.inputSchema.properties?.[actionKey] as { enum?: unknown[]; default?: unknown } | undefined;
    const requestedAction = args[actionKey] ?? actionSchema?.default;
    const action = typeof requestedAction === 'string' && actionSchema?.enum?.includes(requestedAction) ? requestedAction : undefined;

    // Capture explicit per-request root and determine request root hint without polluting global state early
    const explicitRoot = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
    const requestRootHint = explicitRoot ?? getLastKnownProjectRoot();

    const traceId = args.trace_id || args.traceId ? String(args.trace_id || args.traceId) : undefined;
    const sessionId = args.session_id || args.sessionId ? String(args.session_id || args.sessionId) : undefined;

    if (!tool) {
      const errorMsg = `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
      const fallbackRoot = explicitRoot ?? getLastKnownProjectRoot() ?? process.cwd();
      const publicResponse = enforceResponseLimit({ isError: true, content: [{ type: 'text', text: errorMsg }] }, args.max_bytes ?? args.maxBytes);
      StrataTelemetry.recordToolResponse({
        event: 'tool_call_failed',
        tool: name,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startTime),
        input: args,
        status: 'error',
        error: { code: 'UNKNOWN_TOOL', message: errorMsg },
      }, publicResponse, fallbackRoot);
      return publicResponse;
    }

    const wantsStructured =
      args.format === 'json' ||
      args.output_format === 'json' ||
      Boolean(args.include_structured || args.includeStructured);

    try {
      const runnerArgs = wantsStructured ? args : { ...args, _omitStructuredForText: true };
      const response = await runner.run(name, runnerArgs, requestRootHint, extra?.signal);
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
      const { projectRoot: _workerRoot, ...cleanResponse } = response;

      const itemsFound = extractItemsFound(name, args, cleanResponse);
      const isHandlerError = Boolean(cleanResponse?.isError);
      let handlerErrorDiagnosis: { code: string; message: string } | undefined;

      if (isHandlerError) {
        let firstLine = '';
        if (Array.isArray(cleanResponse.content)) {
          const firstText = cleanResponse.content.find((c: any) => typeof c.text === 'string')?.text;
          if (firstText) {
            firstLine = firstText.trim().split('\n')[0].slice(0, 256);
          }
        }
        handlerErrorDiagnosis = {
          code: (cleanResponse.structuredContent?.error as { code?: unknown } | undefined)?.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'HANDLER_ERROR',
          message: firstLine || 'Tool returned error status',
        };
      }

      // Strip redundant structuredContent for text transport before applying the final transport limit
      const transportResponse =
        !wantsStructured &&
        cleanResponse.structuredContent &&
        Array.isArray(cleanResponse.content) &&
        cleanResponse.content.length > 0
          ? {
              ...cleanResponse,
              structuredContent: { summary: 'omitted_for_text_format' },
            }
          : cleanResponse;
      const finalResponse = enforceResponseLimit(transportResponse, args.max_bytes ?? args.maxBytes);
      const isFinalError = isHandlerError || Boolean(finalResponse?.isError);
      if (isFinalError && !handlerErrorDiagnosis) {
        const errCode = (finalResponse?.structuredContent?.error as { code?: unknown } | undefined)?.code;
        const firstText = Array.isArray(finalResponse?.content)
          ? finalResponse.content.find((c: any) => typeof c.text === 'string')?.text
          : undefined;
        handlerErrorDiagnosis = {
          code: typeof errCode === 'string' && errCode ? errCode : 'BUDGET_RESPONSE_TOO_LARGE',
          message: firstText ? firstText.trim().split('\n')[0].slice(0, 256) : 'Response exceeded transport budget',
        };
      }

      StrataTelemetry.recordToolResponse({
        event: isFinalError ? 'tool_call_failed' : 'tool_call_completed',
        tool: name,
        action,
        trace_id: traceId,
        session_id: sessionId,
        duration_ms: durationMs,
        input: args,
        metrics: {
          ...(itemsFound !== undefined ? { items_found: itemsFound } : {}),
        },
        status: isFinalError ? 'error' : 'success',
        error: handlerErrorDiagnosis,
      }, finalResponse, effectiveRoot);

      return finalResponse;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));
      const errorCode = (errorInstance.message.match(/^([A-Z_]+):/) || [])[1] || 'EXECUTION_ERROR';
      const effectiveRoot = explicitRoot ?? requestRootHint ?? process.cwd();

      const publicResponse = enforceResponseLimit({
        isError: true,
        content: [{ type: 'text', text: `Tool error (${name}): ${errorInstance.message}` }],
      }, args.max_bytes ?? args.maxBytes);
      StrataTelemetry.recordToolResponse({
        event: 'tool_call_failed',
        tool: name,
        action,
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
      }, publicResponse, effectiveRoot);
      return publicResponse;
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

