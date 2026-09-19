import { promises as fs } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { collectFiles } from './collector';
import { findProjectRoot } from './path-resolver';
import type {
  ApiClientKind,
  ApiContractItem,
  ApiContractResult,
  ApiMethod,
} from '../types';

/**
 * Normalizes an API URL template (e.g. `/api/users/${id}` or `/api/v1/posts/` + id) into REST-style `/api/users/:id`.
 */
export function normalizeEndpointUrl(rawUrl: string): string {
  let cleaned = rawUrl.trim();

  // Strip wrapping quotes or backticks
  if (
    (cleaned.startsWith('`') && cleaned.endsWith('`')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  // Convert template interpolations ${id} -> :id
  cleaned = cleaned.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
    const cleanExpr = expr.trim().replace(/^params\./, '').replace(/^route\.params\./, '');
    const safeName = cleanExpr.replace(/[^a-zA-Z0-9_]/g, '_');
    return `:${safeName}`;
  });

  // Convert string concatenations e.g. "/api/items/" + itemId -> /api/items/:itemId
  cleaned = cleaned.replace(/['"]\s*\+\s*([a-zA-Z0-9_$.]+)/g, (_match, expr) => {
    const cleanExpr = expr.replace(/^.*\./, '');
    return `:${cleanExpr}`;
  });

  // Clean trailing punctuation or double slashes
  cleaned = cleaned.replace(/([^:])\/{2,}/g, '$1/');
  return cleaned;
}

/**
 * Extracts payload parameter names from body/data options object literal string.
 */
function extractPayloadParams(optionsStr?: string): string[] | undefined {
  if (!optionsStr) return undefined;

  const bodyMatch = optionsStr.match(/(?:body|data)\s*:\s*(?:JSON\.stringify\s*\(\s*)?\{([^}]+)\}/);
  if (bodyMatch && bodyMatch[1]) {
    return bodyMatch[1]
      .split(',')
      .map((item) => item.split(':')[0].trim())
      .filter((param) => /^[a-zA-Z0-9_$]+$/.test(param));
  }

  return undefined;
}

/**
 * Extracts HTTP method from request options object literal string.
 */
function extractMethodFromOptions(optionsStr?: string): ApiMethod {
  if (!optionsStr) return 'GET';

  const methodMatch = optionsStr.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i);
  if (methodMatch && methodMatch[1]) {
    return methodMatch[1].toUpperCase() as ApiMethod;
  }

  return 'GET';
}

/**
 * Scans a source code string and detects all outbound API requests.
 */
export function extractApiContractsFromCode(code: string, filePath: string): ApiContractItem[] {
  const items: ApiContractItem[] = [];
  const lines = code.split('\n');

  // 1. axios.<method>(url, data?, config?)
  const AXIOS_METHOD_REGEX =
    /\baxios\.(get|post|put|patch|delete|head|options)\s*(?:<[^>]+>)?\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")(?:\s*,\s*([^)]*))?\)/gi;

  // 2. $fetch(url, options?) or useFetch(url, options?)
  const NUXT_FETCH_REGEX =
    /\b(\$fetch|useFetch)\s*(?:<[^>]+>)?\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")(?:\s*,\s*(\{[\s\S]*?\}))?\)/gi;

  // 3. fetch(url, options?)
  const NATIVE_FETCH_REGEX =
    /\bfetch\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")(?:\s*,\s*(\{[\s\S]*?\}))?\)/gi;

  // 4. useQuery({ queryKey: [...], queryFn: ... })
  const USE_QUERY_REGEX =
    /\buseQuery\s*\(\s*\{[\s\S]*?queryKey\s*:\s*\[([^\]]+)\]/gi;

  // Helper to compute line and column from regex index
  function getLineCol(index: number): { line: number; column: number } {
    let currentLen = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length + 1; // +1 for newline
      if (currentLen + lineLen > index) {
        return { line: i + 1, column: index - currentLen + 1 };
      }
      currentLen += lineLen;
    }
    return { line: 1, column: 1 };
  }

  // Scan Axios
  let match: RegExpExecArray | null;
  while ((match = AXIOS_METHOD_REGEX.exec(code)) !== null) {
    const rawMethod = match[1].toUpperCase() as ApiMethod;
    const rawUrl = match[2];
    const dataOrOptions = match[3];
    const loc = getLineCol(match.index);

    items.push({
      file: filePath,
      line: loc.line,
      column: loc.column,
      endpoint: normalizeEndpointUrl(rawUrl),
      method: rawMethod,
      clientKind: 'axios',
      payloadParams: extractPayloadParams(dataOrOptions),
    });
  }

  // Scan Nuxt / VueUse $fetch and useFetch
  while ((match = NUXT_FETCH_REGEX.exec(code)) !== null) {
    const clientKind = match[1] === '$fetch' ? '$fetch' : 'useFetch';
    const rawUrl = match[2];
    const optionsStr = match[3];
    const loc = getLineCol(match.index);

    items.push({
      file: filePath,
      line: loc.line,
      column: loc.column,
      endpoint: normalizeEndpointUrl(rawUrl),
      method: extractMethodFromOptions(optionsStr),
      clientKind,
      payloadParams: extractPayloadParams(optionsStr),
    });
  }

  // Scan native fetch
  while ((match = NATIVE_FETCH_REGEX.exec(code)) !== null) {
    // Avoid double counting if it matched $fetch / useFetch
    const preText = code.slice(Math.max(0, match.index - 5), match.index);
    if (preText.endsWith('$') || preText.endsWith('use')) {
      continue;
    }

    const rawUrl = match[1];
    const optionsStr = match[2];
    const loc = getLineCol(match.index);

    items.push({
      file: filePath,
      line: loc.line,
      column: loc.column,
      endpoint: normalizeEndpointUrl(rawUrl),
      method: extractMethodFromOptions(optionsStr),
      clientKind: 'fetch',
      payloadParams: extractPayloadParams(optionsStr),
    });
  }

  // Scan TanStack useQuery
  while ((match = USE_QUERY_REGEX.exec(code)) !== null) {
    const keyContent = match[1];
    const urlMatch = keyContent.match(/['"`]([^'"`]+)['"`]/);
    if (urlMatch && (urlMatch[1].startsWith('/') || urlMatch[1].startsWith('http') || urlMatch[1].includes('api'))) {
      const loc = getLineCol(match.index);
      items.push({
        file: filePath,
        line: loc.line,
        column: loc.column,
        endpoint: normalizeEndpointUrl(urlMatch[1]),
        method: 'GET',
        clientKind: 'useQuery',
      });
    }
  }

  return items;
}

/**
 * Scans the workspace or target directory and extracts all outbound API endpoint contracts.
 */
export async function extractWorkspaceApiContracts(options?: {
  targetPath?: string;
  scopePath?: string;
}): Promise<ApiContractResult> {
  const root = options?.targetPath ? resolve(options.targetPath) : (findProjectRoot() ?? process.cwd());
  const files = await collectFiles(root, options?.scopePath);

  const allEndpoints: ApiContractItem[] = [];
  const endpointSummary: Record<string, { methods: ApiMethod[]; callers: string[] }> = {};

  for (const file of files) {
    try {
      const code = await fs.readFile(file, 'utf-8');
      const items = extractApiContractsFromCode(code, file);

      for (const item of items) {
        allEndpoints.push(item);
        const key = item.endpoint;

        if (!endpointSummary[key]) {
          endpointSummary[key] = { methods: [], callers: [] };
        }

        if (!endpointSummary[key].methods.includes(item.method)) {
          endpointSummary[key].methods.push(item.method);
        }

        const relPath = relative(root, item.file);
        if (!endpointSummary[key].callers.includes(relPath)) {
          endpointSummary[key].callers.push(relPath);
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return {
    workspaceRoot: root,
    totalEndpointsFound: Object.keys(endpointSummary).length,
    endpoints: allEndpoints,
    endpointSummary,
    _meta: {
      framework: 'multi-framework',
      version: '0.7.3',
    },
  };
}

/**
 * Formats API Contract extraction results as human-readable markdown.
 */
export function formatApiContractsAsText(result: ApiContractResult): string {
  const lines: string[] = [
    `# Cross-Boundary API Contracts`,
    `- **Workspace:** \`${result.workspaceRoot}\``,
    `- **Total Unique Endpoints:** ${result.totalEndpointsFound}`,
    `- **Total API Invocations:** ${result.endpoints.length}`,
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
  }

  if (result.endpoints.length > 30) {
    lines.push(`- *(and ${result.endpoints.length - 30} more calls...)*`);
  }

  return lines.join('\n');
}
