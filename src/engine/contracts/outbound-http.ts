import ts from 'typescript';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { createDocumentAdapter } from '../../adapters/factory';
import type { ApiClientKind, ApiMethod } from '../../types';
import { reactBindings } from '../parsers/react-bindings';
import { callableName } from '../parsers/ts-syntax';
import type { CallbackTarget } from './callback-definition';
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
  const field = lastPossibleProperty(object, name);
  if (field && ts.isPropertyAssignment(field) && propertyName(field.name) === name) return field.initializer;
  if (field && ts.isShorthandPropertyAssignment(field)) return field.name;
}

function lastPossibleProperty(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.findLast(field => ts.isSpreadAssignment(field) ||
    ts.isComputedPropertyName(field.name) || propertyName(field.name) === name);
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function requestMethod(options: ts.Expression | undefined): ApiMethod {
  if (!options) return 'GET';
  if (!ts.isObjectLiteralExpression(options)) return 'UNKNOWN';
  const field = lastPossibleProperty(options, 'method');
  if (!field) return 'GET';
  if (!ts.isPropertyAssignment(field) || propertyName(field.name) !== 'method' ||
      !ts.isStringLiteralLike(field.initializer)) return 'UNKNOWN';
  const method = field.initializer.text.toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method as ApiMethod : 'UNKNOWN';
}

interface Mutation {
  callbackTarget?: () => CallbackTarget | undefined;
  line: number;
  column: number;
  symbol: string;
  optimisticUpdate: boolean;
}

interface FormDeclaration {
  name: string;
  fields: {key: string; isFile: boolean}[];
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
  mutation?: Mutation;
  inertiaRouter?: { ziggy: boolean };
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

function containingMutation(node: ts.Node, callbacks: Map<ts.Node, Mutation>): Mutation | undefined {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const mutation = callbacks.get(ancestor);
    if (mutation) return mutation;
    if (ts.isFunctionLike(ancestor)) break;
  }
}

function readFormDeclaration(node: ts.CallExpression): FormDeclaration | undefined {
  if (!ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name)) return;
  const first = node.arguments[0];
  const initial = first && ts.isStringLiteralLike(first) ? node.arguments[1] : first;
  if (!initial || !ts.isObjectLiteralExpression(initial)) return;
  const fields = initial.properties.flatMap(field => {
    if (!ts.isPropertyAssignment(field) && !ts.isShorthandPropertyAssignment(field)) return [];
    const key = propertyName(field.name);
    if (key === undefined) return [];
    const value = ts.isPropertyAssignment(field) ? field.initializer : undefined;
    const isFile = !!value && (value.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'File'));
    return [{ key, isFile }];
  });
  return { name: node.parent.name.text, fields };
}

/** Reads call-local options from the AST, including source coordinates. */
export function observeHttpDocument(code: string, filePath: string) {
  const items: OutboundHttpCall[] = [];
  const mutations: Mutation[] = [];
  const forms: FormDeclaration[] = [];
  const adapter = createDocumentAdapter(filePath, code);
  const blocks = adapter.getScriptBlocks().map(block => ({ content: block.content, lang: block.lang, start: { line: block.loc.start.line, column: block.loc.start.column } }));
  const template = adapter.getTemplateBlock();
  if (template && adapter.type === 'vue') {
    const expressions = extractTemplateExpressions(template.content).map(expression => {
      const start = remapPosition(expression.start.line, expression.start.column, template.loc.start);
      return { content: expression.content, lang: 'ts', start };
    });
    blocks.unshift(...expressions);
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
        blocks.push({ content: child.loc.source, lang: 'ts', start });
      }
    });
  }
  for (const block of blocks) {
    const sf = parseTypeScript(filePath, block.content,
      adapter.isJsx() || /^(?:tsx|jsx)$/.test(block.lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const location = (node: ts.Node) => {
      const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return remapPosition(position.line + 1, position.character + 1, block.start);
    };
    let bindings: ReturnType<typeof reactBindings> | undefined;
    const mutationNodes = new Map<ts.Node, Mutation>();
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (callee === 'useMutation') {
          const options = node.arguments[0];
          const callback = objectProperty(options, 'mutationFn');
          if (callback) {
            const body = ts.isArrowFunction(callback) ? callback.body : callback;
            const target = ts.isCallExpression(body) ? body.expression : body;
            const symbol = ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) ? target.getText(sf) : 'mutationFn';
            const optimisticUpdate = ts.isObjectLiteralExpression(options) &&
              options.properties.some(p => p.name && propertyName(p.name) === 'onMutate');
            const mutation: Mutation = { ...location(node), symbol, optimisticUpdate };
            if (ts.isIdentifier(target) && (target === callback || (ts.isArrowFunction(callback) && ts.isCallExpression(body)))) {
              mutation.callbackTarget = () => {
                bindings ??= reactBindings(sf);
                const binding = bindings.binding(target);
                if (!binding || binding.ambiguous || binding.typeOnly) return;
                if (binding.source && binding.imported && ts.isImportSpecifier(binding.declaration) && /^\.{1,2}\//.test(binding.source)) {
                  return { module: binding.source, symbol: binding.imported };
                }
                const name = callableName(binding.declaration);
                if (name) return { definition: { file: filePath, symbol: name.text, ...location(name) } };
              };
            }
            mutations.push(mutation);
            mutationNodes.set(callback, mutation);
          }
        }
        if (callee === 'useForm') {
          const declaration = readFormDeclaration(node);
          if (declaration) forms.push(declaration);
        }
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
          method = requestMethod(options);
        } else if (router) {
          clientKind = 'custom';
          const verb = router[1].toLowerCase();
          method = verb === 'visit' ? requestMethod(node.arguments[1]) : verb.toUpperCase() as ApiMethod;
          payload = verb === 'visit' || verb === 'delete' ? objectProperty(node.arguments[1], 'data') : node.arguments[1];
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
          items.push({ file: filePath, ...location(node), ...endpoint, method, clientKind,
            payloadKeys: payloadParams?.length ? payloadParams : undefined,
            ...(router && { inertiaRouter: { ziggy: ts.isCallExpression(node.arguments[0]) } }),
            mutation: containingMutation(node, mutationNodes) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return { items, mutations, forms };
}

export function extractOutboundHttpCalls(code: string, filePath: string): OutboundHttpCall[] {
  return observeHttpDocument(code, filePath).items;
}
