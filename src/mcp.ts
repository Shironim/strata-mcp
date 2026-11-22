#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, findTool } from './tools';
import {
  getStrataPrompt,
  listStrataPrompts,
  listStrataResources,
  listStrataResourceTemplates,
  readStrataResource,
} from './resources-and-prompts';
import { AnalysisSupervisor } from './analysis-supervisor';
import { STRATA_INSTRUCTIONS } from './instructions';
import { STRATA_VERSION } from './version';
import { StrataTelemetry, runWithTelemetryStage } from './engine/telemetry';
import { defaultSyncCoordinator } from './engine/v2';
import { enforceResponseLimit } from './engine/context-budget';
import {
  getLastKnownProjectRoot,
  runWithRequestProjectRoot,
  setLastKnownProjectRoot,
} from './engine/path-resolver';

export { TOOLS, findTool } from './tools';

export {
  parseSafePositiveInt,
  parseStringList,
  parseAliasMapInput,
  normalizeAuditTarget,
  VALID_AUDIT_TARGETS,
} from './engine/path-resolver';

export function extractItemsFound(
  _toolName: string,
  _args: Record<string, unknown>,
  response: any
): number | undefined {
  if (response?.isError) return 0;
  const data = response?.structuredContent?.data;
  if (!data || typeof data !== 'object') return undefined;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.matches)) return data.matches.length;
  if (Array.isArray(data.packages)) return data.packages.length;
  if (Array.isArray(data.routes)) return data.routes.length;
  if (Array.isArray(data.files)) return data.files.length;
  if (Array.isArray(data.outline)) return data.outline.length;
  if (typeof data.content === 'string') return 1;
  return undefined;
}

export function createMcpServer(): Server {
  const runner = new AnalysisSupervisor();
  const server = new Server(
    {
      name: 'strata',
      version: STRATA_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: STRATA_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => listStrataResources());
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
    listStrataResourceTemplates()
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const rootHint = getLastKnownProjectRoot();
    return await runWithRequestProjectRoot(rootHint, () =>
      readStrataResource(request.params.uri, rootHint)
    );
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => listStrataPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getStrataPrompt(request.params.name, request.params.arguments)
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema, annotations, _meta }) => ({
      name,
      description,
      inputSchema,
      annotations,
      ...(_meta ? { _meta } : {}),
    })),
  }));

  const MAX_SESSION_ROOTS = 64;
  const sessionRoots = new Map<string, string>();
  const rememberSessionRoot = (sid: string, rootPath: string) => {
    if (sessionRoots.has(sid)) sessionRoots.delete(sid);
    sessionRoots.set(sid, rootPath);
    if (sessionRoots.size > MAX_SESSION_ROOTS) {
      const oldest = sessionRoots.keys().next().value;
      if (oldest !== undefined) sessionRoots.delete(oldest);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<any> => {
    const name = request.params.name;
    const args =
      request.params.arguments && typeof request.params.arguments === 'object'
        ? (request.params.arguments as Record<string, unknown>)
        : {};
    const startTime = performance.now();
    const tool = findTool(name);

    const traceId =
      args.trace_id || args.traceId
        ? String(args.trace_id || args.traceId)
        : randomUUID().slice(0, 12);
    const sessionId =
      args.session_id || args.sessionId
        ? String(args.session_id || args.sessionId)
        : undefined;
    const explicitRoot =
      typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
    const requestRootHint =
      explicitRoot ??
      (sessionId ? sessionRoots.get(sessionId) : undefined) ??
      getLastKnownProjectRoot();

    if (!tool) {
      const errorMsg = `Unknown tool name: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`;
      const fallbackRoot = explicitRoot ?? getLastKnownProjectRoot() ?? process.cwd();
      const publicResponse = enforceResponseLimit(
        { isError: true, content: [{ type: 'text', text: errorMsg }] },
        args.max_bytes as number | undefined
      );
      StrataTelemetry.recordToolResponse(
        {
          event: 'tool_call_failed',
          tool: name,
          trace_id: traceId,
          session_id: sessionId,
          duration_ms: Math.round(performance.now() - startTime),
          input: args,
          status: 'error',
          error: { code: 'UNKNOWN_TOOL', message: errorMsg },
        },
        publicResponse,
        fallbackRoot
      );
      return publicResponse;
    }

    const hasUiResource = Boolean((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri);
    const wantsStructured =
      args.format === 'json' || Boolean(args.include_structured) || hasUiResource;
    const progressToken = (request.params as { _meta?: { progressToken?: string | number } } | undefined)
      ?._meta?.progressToken;
    const onProgress =
      progressToken !== undefined && typeof extra?.sendNotification === 'function'
        ? (progress: number, total?: number, message?: string) => {
            void extra
              .sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress,
                  ...(total !== undefined ? { total } : {}),
                  ...(message ? { message } : {}),
                },
              })
              .catch(() => {});
          }
        : undefined;

    return await runWithTelemetryStage(async () => {
      try {
        const response = await runWithRequestProjectRoot(requestRootHint, () =>
          runner.run(name, args, requestRootHint, extra?.signal, onProgress)
        );
        const durationMs = Math.round(performance.now() - startTime);

        if (!response?.isError) {
          const resolvedRoot = explicitRoot ?? response?.projectRoot;
          if (resolvedRoot) {
            if (sessionId) rememberSessionRoot(sessionId, resolvedRoot);
            else setLastKnownProjectRoot(resolvedRoot);
            if (existsSync(join(resolvedRoot, '.strata', 'graph.db'))) {
              defaultSyncCoordinator.startWatching(resolvedRoot);
            }
          }
        }

        const effectiveRoot =
          response?.projectRoot ?? explicitRoot ?? requestRootHint ?? process.cwd();
        const { projectRoot: _workerRoot, ...cleanResponse } = response;
        const itemsFound = extractItemsFound(name, args, cleanResponse);
        const isHandlerError = Boolean(cleanResponse?.isError);

        const transportResponse = (() => {
          if (
            !wantsStructured &&
            cleanResponse.structuredContent &&
            Array.isArray(cleanResponse.content) &&
            cleanResponse.content.length > 0
          ) {
            const { structuredContent: _omitted, ...withoutStructured } = cleanResponse;
            return withoutStructured;
          }
          return cleanResponse;
        })();

        const finalResponse = enforceResponseLimit(
          transportResponse,
          args.max_bytes as number | undefined
        );
        const isFinalError = isHandlerError || Boolean(finalResponse?.isError);
        const errCode = (cleanResponse?.structuredContent?.error as { code?: string } | undefined)
          ?.code;
        const firstText = Array.isArray(finalResponse?.content)
          ? finalResponse.content.find((c: any) => typeof c.text === 'string')?.text
          : undefined;

        StrataTelemetry.recordToolResponse(
          {
            event: isFinalError ? 'tool_call_failed' : 'tool_call_completed',
            tool: name,
            trace_id: traceId,
            session_id: sessionId,
            duration_ms: durationMs,
            input: args,
            status: isFinalError ? 'error' : 'success',
            ...(itemsFound !== undefined ? { metrics: { items_found: itemsFound } } : {}),
            ...(isFinalError
              ? {
                  error: {
                    code: errCode ?? 'HANDLER_ERROR',
                    message: firstText ? firstText.trim().split('\n')[0].slice(0, 256) : 'Tool error',
                  },
                }
              : {}),
          },
          finalResponse,
          effectiveRoot
        );

        return finalResponse;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const fallbackRoot = explicitRoot ?? requestRootHint ?? process.cwd();
        const errorResponse = enforceResponseLimit(
          { isError: true, content: [{ type: 'text', text: `[INTERNAL_ERROR] ${errorMsg}` }] },
          args.max_bytes as number | undefined
        );
        StrataTelemetry.recordToolResponse(
          {
            event: 'tool_call_failed',
            tool: name,
            trace_id: traceId,
            session_id: sessionId,
            duration_ms: Math.round(performance.now() - startTime),
            input: args,
            status: 'error',
            error: { code: 'INTERNAL_ERROR', message: errorMsg },
          },
          errorResponse,
          fallbackRoot
        );
        return errorResponse;
      }
    });
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await runner.close();
    await originalClose();
  };

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await server.connect(transport);
  defaultSyncCoordinator.warmupInBackground(process.cwd());
}

if (import.meta.main) {
  startMcpServer().catch((err) => {
    console.error('Failed to start strata-mcp server:', err);
    process.exit(1);
  });
}
