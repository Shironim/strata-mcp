import { synthesizeBackendTargetHint } from './contracts/backend-target-hint';
import { extractOutboundHttpCalls } from './contracts/outbound-http';
import { readSourceFile } from './source-file';
import { promises as fs } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { collectFiles } from './collector';
import { findProjectRoot } from './path-resolver';
import { STRATA_VERSION } from '../version';
import type {
  ApiContractItem,
  ApiContractResult,
  ApiMethod,
  ExtractApiContractsOptions,
} from '../types';

export type { ExtractApiContractsOptions };

export { synthesizeBackendTargetHint } from './contracts/backend-target-hint';
export { normalizeEndpointUrl } from './contracts/outbound-http';

/** Projects outbound call observations into the public workspace audit result. */
export function extractApiContractsFromCode(code: string, filePath: string): ApiContractItem[] {
  return extractOutboundHttpCalls(code, filePath).map(call => ({
    file: call.file,
    line: call.line,
    column: call.column,
    endpoint: call.endpoint,
    method: call.method,
    clientKind: call.clientKind,
    payloadParams: call.payloadKeys,
    backendTargetHint: synthesizeBackendTargetHint(call.method, call.endpoint),
  }));
}

/**
 * Scans the workspace or target directory and extracts all outbound API endpoint contracts.
 */
export async function extractWorkspaceApiContracts(
  options?: ExtractApiContractsOptions
): Promise<ApiContractResult> {
  const root = options?.targetPath ? resolve(options.targetPath) : (findProjectRoot(process.cwd()) ?? process.cwd());
  const scanTarget = options?.scopePath ? resolve(root, options.scopePath) : root;
  const files = await collectFiles(scanTarget, { excludeDirs: options?.excludeDirs, ignoreRoot: root });

  const allEndpoints: ApiContractItem[] = [];
  const summaryMap = new Map<string, { methods: ApiMethod[]; callers: string[] }>();

  for (const file of files) {
    let code = '';
    try {
      code = await readSourceFile(file);
    } catch {
      // Ignore unreadable files
      continue;
    }

    const items = extractApiContractsFromCode(code, file);

    for (const item of items) {
      allEndpoints.push(item);
      const key = item.endpoint;

      let entry = summaryMap.get(key);
      if (!entry) {
        entry = { methods: [], callers: [] };
        summaryMap.set(key, entry);
      }

      if (!entry.methods.includes(item.method)) {
        entry.methods.push(item.method);
      }

      const relPath = relative(root, item.file);
      if (!entry.callers.includes(relPath)) {
        entry.callers.push(relPath);
      }
    }
  }

  const endpointSummary: Record<string, { methods: ApiMethod[]; callers: string[] }> =
    Object.fromEntries(summaryMap.entries());

  return {
    workspaceRoot: root,
    totalEndpointsFound: summaryMap.size,
    endpoints: allEndpoints,
    endpointSummary,
    _meta: {
      version: STRATA_VERSION,
    },
  };
}

/**
 * Formats API Contract extraction results as human-readable markdown.
 */
export function formatApiContractsAsText(result: ApiContractResult): string {
  const totalInvocations = (result as ApiContractResult & { totalAvailable?: number }).totalAvailable ?? result.endpoints.length;
  const lines: string[] = [
    `# Cross-Boundary API Contracts`,
    `- **Workspace:** \`${result.workspaceRoot}\``,
    `- **Total Unique Endpoints:** ${result.totalEndpointsFound}`,
    `- **Total API Invocations:** ${totalInvocations}`,
    '',
  ];

  if (result.totalEndpointsFound === 0) {
    lines.push('No outbound network API calls (fetch, axios, useFetch, useQuery) found.');
    return lines.join('\n');
  }

  lines.push('### Discovered API Endpoints & Callers:');
  const sortedEndpoints = Object.keys(result.endpointSummary).sort();

  for (const ep of sortedEndpoints) {
    const summary = result.endpointSummary[ep];
    const methodsStr = summary.methods.join(', ') || 'GET';
    lines.push(`- **\`[${methodsStr}] ${ep}\`**`);
    lines.push(`  - *Callers (${summary.callers.length}):* ${summary.callers.map((c) => `\`${c}\``).join(', ')}`);
  }

  lines.push('');
  lines.push('### Detailed Invocation Sites:');
  for (const item of result.endpoints.slice(0, 30)) {
    const payloadStr = item.payloadParams?.length ? ` (Payload: ${item.payloadParams.join(', ')})` : '';
    lines.push(
      `- **\`${item.method}\`** \`${item.endpoint}\` via *${item.clientKind}* at [${basename(item.file)}#L${item.line}](file://${item.file}#L${item.line})${payloadStr}`
    );
    if (item.backendTargetHint?.namedRoute) {
      lines.push(
        `  - *Backend Target Hint:* \`${item.backendTargetHint.targetIntent}\` ➔ \`${item.backendTargetHint.suggestedSymbols[0]}\` *(Pure Naming Convention Heuristic - verify actual routes)*`
      );
    }
  }

  if (result.endpoints.length > 30) {
    lines.push(`- *(and ${result.endpoints.length - 30} more calls...)*`);
  }

  return lines.join('\n');
}
