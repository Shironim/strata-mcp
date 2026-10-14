import { readSourceFile } from './source-file';
import { promises as fs } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { collectFiles } from './collector';
import ts from 'typescript';
import { createDocumentAdapter } from '../adapters/factory';
import { remapPosition } from './remapper';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { walkVueDom } from './graph/ast-helpers';
import { extractTemplateExpressions } from './template';
import { findProjectRoot } from './path-resolver';
import { STRATA_VERSION } from '../version';
import type {
  ApiClientKind,
  ApiContractItem,
  ApiContractResult,
  ApiMethod,
  BackendTargetHint,
  ExtractApiContractsOptions,
} from '../types';

export type { ExtractApiContractsOptions };

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function singularize(word: string): string {
  if (!word) return '';
  const lower = word.toLowerCase();
  if (
    lower === 'checkout' ||
    lower === 'status' ||
    lower === 'news' ||
    lower === 'business' ||
    lower === 'process'
  ) {
    return word;
  }
  if (lower.endsWith('ies') && lower.length > 4) {
    return word.slice(0, -3) + 'y';
  }
  if (
    lower.endsWith('es') &&
    (lower.endsWith('xes') || lower.endsWith('shes') || lower.endsWith('ches')) &&
    lower.length > 3
  ) {
    return word.slice(0, -2);
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Synthesizes a bridge hint for downstream backend analysis tools or agent vertical-slice tracers.
 * Transforms frontend outbound endpoints (e.g. POST /api/v1/checkout or route('orders.store'))
 * into backend controller, action, and route intent candidates.
 */
export function synthesizeBackendTargetHint(
  method: ApiMethod | string,
  endpoint: string
): BackendTargetHint {
  const normMethod = (method || 'GET').toUpperCase();
  const trimmedEndpoint = endpoint.trim();

  // 1. Detect Ziggy named routes e.g. route('checkout.store') or 'orders.index'
  const ziggyMatch = trimmedEndpoint.match(/^(?:route\s*\(\s*)?['"]?([a-zA-Z0-9_.-]+)['"]?\s*\)?$/);
  const isNamedRoute = Boolean(
    ziggyMatch &&
    !trimmedEndpoint.startsWith('/') &&
    !trimmedEndpoint.startsWith('http') &&
    ziggyMatch[1].includes('.')
  );

  if (isNamedRoute && ziggyMatch) {
    const namedRoute = ziggyMatch[1];
    const parts = namedRoute.split('.');
    const resource = parts[0];
    const action = parts[parts.length - 1];
    const entityName = capitalize(singularize(resource));
    const targetIntent = `${normMethod} ${namedRoute}`;

    return {
      targetIntent,
      routePattern: namedRoute,
      namedRoute,
      suggestedSymbols: [
        `${entityName}Controller`,
        `${entityName}Controller@${action}`,
        `${entityName}Action`,
        `${entityName}Service`,
      ],
    };
  }

  // 2. Normalize REST path
  // Strip protocol, host, and query params
  const cleanPath = trimmedEndpoint
    .replace(/^https?:\/\/[^/]+/i, '')
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  // Strip common prefix like api/v1/ or api/
  const strippedPath = cleanPath.replace(/^api\/(?:v[0-9]+\/)?/i, '');
  const segments = strippedPath.split('/').filter(Boolean);

  // Extract non-parameter resource segments (e.g. 'users', 'posts', 'checkout')
  const resourceSegments = segments.filter((s) => !s.startsWith(':') && !s.startsWith('{'));
  const lastResource = resourceSegments[resourceSegments.length - 1] || 'Default';
  const hasParamAtEnd =
    segments[segments.length - 1]?.startsWith(':') ||
    segments[segments.length - 1]?.startsWith('{');

  const entityName = capitalize(singularize(lastResource));

  // Determine standard REST action from HTTP method & path shape
  let suggestedAction = 'handle';
  const lowerResource = lastResource.toLowerCase();
  const knownActionVerbs = [
    'checkout',
    'login',
    'logout',
    'register',
    'verify',
    'upload',
    'search',
    'export',
    'import',
    'cancel',
    'process',
    'sync',
  ];

  if (knownActionVerbs.includes(lowerResource)) {
    suggestedAction = lowerResource;
  } else if (normMethod === 'GET') {
    suggestedAction = hasParamAtEnd ? 'show' : 'index';
  } else if (normMethod === 'POST') {
    suggestedAction = 'store';
  } else if (normMethod === 'PUT' || normMethod === 'PATCH') {
    suggestedAction = 'update';
  } else if (normMethod === 'DELETE') {
    suggestedAction = 'destroy';
  }

  const suggestedSymbols = [
    `${entityName}Controller`,
    `${entityName}Controller@${suggestedAction}`,
    `${entityName}Action`,
    `${entityName}Service`,
  ];

  const targetIntent = `${normMethod} ${cleanPath || trimmedEndpoint}`;

  return {
    targetIntent,
    routePattern: cleanPath || trimmedEndpoint,
    suggestedSymbols,
  };
}

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
    let cleanExpr = expr
      .trim()
      .replace(/\.value\b/g, '')
      .replace(/^(?:params|route\.params|props|item|user|record|data)\./, '');
    if (cleanExpr.includes('.')) {
      cleanExpr = cleanExpr.split('.').pop() || cleanExpr;
    }
    const safeName = cleanExpr.replace(/[^a-zA-Z0-9_]/g, '_');
    return `:${safeName}`;
  });

  // Convert string concatenations e.g. "/api/items/" + itemId -> /api/items/:itemId
  cleaned = cleaned.replace(/['"]\s*\+\s*([a-zA-Z0-9_$.]+)/g, (_match, expr) => {
    let cleanExpr = expr.replace(/\.value\b/g, '').replace(/^.*\./, '');
    return `:${cleanExpr}`;
  });

  // Strip any leftover dangling quotes at head or tail
  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, '');

  // Clean trailing punctuation or double slashes
  cleaned = cleaned.replace(/([^:])\/{2,}/g, '$1/');
  return cleaned;
}

function objectProperty(object: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const property = object.properties.find(p => ts.isPropertyAssignment(p) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function literalEndpoint(node: ts.Expression | undefined, sf: ts.SourceFile): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
    return normalizeEndpointUrl(node.getText(sf));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(node.left)) {
    return normalizeEndpointUrl(node.getText(sf));
  }
  return undefined;
}

/** Extracts syntactic API calls; backend symbols remain inferred candidates. */
export function extractApiContractsFromCode(code: string, filePath: string): ApiContractItem[] {
  const items: ApiContractItem[] = [];
  const adapter = createDocumentAdapter(filePath, code);
  const blocks = adapter.getScriptBlocks();
  const template = adapter.getTemplateBlock();
  if (template && adapter.type === 'vue') {
    for (const expression of extractTemplateExpressions(template.content)) {
      const start = remapPosition(expression.start.line, expression.start.column, template.loc.start);
      for (const item of extractApiContractsFromCode(expression.content, 'expression.ts')) {
        items.push({ ...item, file: filePath, ...remapPosition(item.line, item.column, { ...start, offset: 0 }) });
      }
    }
  }
  if (template && adapter.type === 'astro') {
    const ast = parseDom(template.content, { onError: () => {} });
    walkVueDom(ast, el => {
      if (el.tag !== 'script') return;
      const type = el.props.find(p => p.type === NodeTypes.ATTRIBUTE && p.name === 'type');
      if (type?.type === NodeTypes.ATTRIBUTE && type.value &&
        !['module', 'text/javascript', 'application/javascript'].includes(type.value.content)) return;
      for (const child of el.children) {
        if (child.type !== NodeTypes.TEXT) continue;
        const start = remapPosition(child.loc.start.line, child.loc.start.column, template.loc.start);
        const end = remapPosition(child.loc.end.line, child.loc.end.column, template.loc.start);
        blocks.push({ type: 'script', content: child.loc.source, lang: 'ts', loc: {
          start: { ...start, offset: template.loc.start.offset + child.loc.start.offset },
          end: { ...end, offset: template.loc.start.offset + child.loc.end.offset },
        } });
      }
    });
  }
  for (const block of blocks) {
    const sf = ts.createSourceFile(filePath, block.content, ts.ScriptTarget.Latest, true,
      block.lang === 'tsx' || block.lang === 'jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        let method: ApiMethod = 'GET';
        let clientKind: ApiClientKind | undefined;
        let endpoint: string | undefined;
        let options: ts.Expression | undefined;
        let payload: ts.Expression | undefined;
        const axios = callee.match(/^axios\.(get|post|put|patch|delete|head|options)$/i);
        const router = callee.match(/^router\.(post|put|patch|delete|get|visit)$/i);
        if (axios) {
          clientKind = 'axios';
          method = axios[1].toUpperCase() as ApiMethod;
          endpoint = literalEndpoint(node.arguments[0], sf);
          if (['POST', 'PUT', 'PATCH'].includes(method)) payload = node.arguments[1];
          else options = node.arguments[1];
        } else if (['fetch', '$fetch', 'useFetch'].includes(callee)) {
          clientKind = callee as ApiClientKind;
          endpoint = literalEndpoint(node.arguments[0], sf);
          options = node.arguments[1];
          const methodNode = objectProperty(options, 'method');
          if (methodNode && ts.isStringLiteralLike(methodNode)) {
            const value = methodNode.text.toUpperCase();
            if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value)) method = value as ApiMethod;
          }
        } else if (router) {
          clientKind = 'custom';
          method = router[1].toLowerCase() === 'visit' ? 'GET' : router[1].toUpperCase() as ApiMethod;
          const url = node.arguments[0];
          if (url && ts.isCallExpression(url) && url.expression.getText(sf) === 'route' && url.arguments[0] && ts.isStringLiteralLike(url.arguments[0])) {
            endpoint = `route('${url.arguments[0].text}')`;
          } else endpoint = literalEndpoint(url, sf);
        } else if (callee === 'useSWR') {
          clientKind = 'custom';
          endpoint = literalEndpoint(node.arguments[0], sf);
        } else if (callee === 'useQuery') {
          const key = objectProperty(node.arguments[0], 'queryKey');
          if (key && ts.isArrayLiteralExpression(key)) {
            const candidate = key.elements.find(el => ts.isStringLiteralLike(el) &&
              (el.text.startsWith('/') || el.text.startsWith('http') || el.text.includes('api')));
            if (candidate && ts.isStringLiteralLike(candidate)) {
              clientKind = 'useQuery';
              endpoint = candidate.text;
            }
          }
        }
        if (clientKind && endpoint) {
          payload ??= objectProperty(options, 'body') ?? objectProperty(options, 'data');
          if (payload && ts.isCallExpression(payload) && payload.expression.getText(sf) === 'JSON.stringify') {
            payload = payload.arguments[0];
          }
          const payloadParams = payload && ts.isObjectLiteralExpression(payload)
            ? payload.properties.flatMap(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [])
            : undefined;
          const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const absolute = remapPosition(position.line + 1, position.character + 1, block.loc.start);
          items.push({ file: filePath, ...absolute, endpoint, method, clientKind,
            payloadParams: payloadParams?.length ? payloadParams : undefined,
            backendTargetHint: synthesizeBackendTargetHint(method, endpoint) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return items;
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
    if (item.backendTargetHint) {
      lines.push(
        `  - *Backend Target Hint:* \`${item.backendTargetHint.targetIntent}\` ➔ \`${item.backendTargetHint.suggestedSymbols[0]}\``
      );
    }
  }

  if (result.endpoints.length > 30) {
    lines.push(`- *(and ${result.endpoints.length - 30} more calls...)*`);
  }

  return lines.join('\n');
}
