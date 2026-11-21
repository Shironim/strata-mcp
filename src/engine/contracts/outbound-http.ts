import ts from 'typescript';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { createDocumentAdapter } from '../../adapters/factory';
import type { ApiClientKind, ApiMethod } from '../../types';
import { walkVueDom } from '../graph/ast-helpers';
import { remapPosition } from '../remapper';
import { parseTypeScript } from '../source-parser';
import { extractTemplateExpressions } from '../template';

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

interface Endpoint {
  endpoint: string;
  rawEndpoint: string;
  endpointSource: 'literal' | 'template-literal' | 'variable';
}

export interface OutboundHttpCall extends Endpoint {
  file: string;
  line: number;
  column: number;
  method: ApiMethod;
  clientKind: ApiClientKind;
  payloadKeys?: string[];
  mutation?: { line: number; column: number; optimisticUpdate: boolean };
}

function literalEndpoint(node: ts.Expression | undefined, sf: ts.SourceFile): Endpoint | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) {
    return { endpoint: normalizeEndpointUrl(node.getText(sf)), rawEndpoint: node.text.trim(), endpointSource: 'literal' };
  }
  if (ts.isTemplateExpression(node)) {
    const rawEndpoint = node.getText(sf).slice(1, -1).trim();
    return { endpoint: normalizeEndpointUrl(node.getText(sf)), rawEndpoint, endpointSource: 'template-literal' };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(node.left)) {
    const rawEndpoint = node.getText(sf);
    return { endpoint: normalizeEndpointUrl(rawEndpoint), rawEndpoint, endpointSource: 'variable' };
  }
  return undefined;
}

function containingMutation(node: ts.Node, sf: ts.SourceFile): ts.CallExpression | undefined {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (!ts.isPropertyAssignment(ancestor) || ancestor.name.getText(sf) !== 'mutationFn') continue;
    const object = ancestor.parent;
    if (!ts.isObjectLiteralExpression(object)) continue;
    const call = object.parent;
    if (ts.isCallExpression(call) && call.expression.getText(sf) === 'useMutation') return call;
  }
}

/** Reads call-local options from the AST, including source coordinates. */
export function extractOutboundHttpCalls(code: string, filePath: string): OutboundHttpCall[] {
  const items: OutboundHttpCall[] = [];
  const adapter = createDocumentAdapter(filePath, code);
  const blocks = adapter.getScriptBlocks();
  const template = adapter.getTemplateBlock();
  if (template && adapter.type === 'vue') {
    for (const expression of extractTemplateExpressions(template.content)) {
      const start = remapPosition(expression.start.line, expression.start.column, template.loc.start);
      for (const item of extractOutboundHttpCalls(expression.content, 'expression.ts')) {
        const expressionStart = { ...start, offset: 0 };
        items.push({ ...item, file: filePath, ...remapPosition(item.line, item.column, expressionStart),
          mutation: item.mutation && { ...item.mutation, ...remapPosition(item.mutation.line, item.mutation.column, expressionStart) } });
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
    const sf = parseTypeScript(filePath, block.content,
      adapter.isJsx() || /^(?:tsx|jsx)$/.test(block.lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const location = (node: ts.Node) => {
      const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return remapPosition(position.line + 1, position.character + 1, block.loc.start);
    };
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        let method: ApiMethod = 'GET';
        let clientKind: ApiClientKind | undefined;
        let endpoint: Endpoint | undefined;
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
            const name = `route('${url.arguments[0].text}')`;
            endpoint = { endpoint: name, rawEndpoint: name, endpointSource: 'literal' };
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
              endpoint = { endpoint: candidate.text, rawEndpoint: candidate.text, endpointSource: 'literal' };
            }
          }
        }
        if (clientKind && endpoint?.endpoint) {
          payload ??= objectProperty(options, 'body') ?? objectProperty(options, 'data');
          if (payload && ts.isCallExpression(payload) && payload.expression.getText(sf) === 'JSON.stringify') {
            payload = payload.arguments[0];
          }
          const payloadParams = payload && ts.isObjectLiteralExpression(payload)
            ? payload.properties.flatMap(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [])
            : undefined;
          const mutation = containingMutation(node, sf);
          const mutationOptions = mutation?.arguments[0];
          const optimisticUpdate = Boolean(mutationOptions && ts.isObjectLiteralExpression(mutationOptions)
            && mutationOptions.properties.some(property => property.name?.getText(sf) === 'onMutate'));
          items.push({ file: filePath, ...location(node), ...endpoint, method, clientKind,
            payloadKeys: payloadParams?.length ? payloadParams : undefined,
            mutation: mutation && { ...location(mutation), optimisticUpdate } });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return items;
}

