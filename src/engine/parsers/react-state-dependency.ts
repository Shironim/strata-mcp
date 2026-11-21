import { parseTypeScript } from '../source-parser';
import ts from 'typescript';
import type { Evidence, StateDependencyInfo, StateDependencyItem } from '../../types';
import { reactBindings } from './react-bindings';
import { unwrapExpression } from './ts-syntax';

const BUILTINS = new Set(['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useId', 'useContext', 'useReducer',
  'useTransition', 'useDeferredValue', 'useImperativeHandle', 'useLayoutEffect', 'useInsertionEffect', 'useSyncExternalStore', 'useActionState', 'useOptimistic']);
const REDUX = /^(useSelector|useDispatch|useAppSelector|useAppDispatch)$/;
const ACTION = /^(set|update|delete|add|remove|open|close|mutate|trigger|toggle|reset|dispatch|handle|submit|checkout|clear)/i;
const STORE_HOOK = /^use[A-Za-z0-9_$]*Store$/;
// Conventional collection reads remain candidates: custom methods and callbacks can have side effects.
const COLLECTION_READS = new Set(['filter', 'slice', 'map', 'flat', 'flatMap', 'concat', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'includes', 'indexOf', 'lastIndexOf', 'some', 'every', 'reduce', 'reduceRight',
  'forEach', 'join', 'at', 'entries', 'keys', 'values', 'toSorted', 'toReversed', 'toSpliced', 'with']);
interface Dependency { kind: StateDependencyItem['kind']; identifier: string; evidence: Evidence }

export function extractReactStateDependencies(content: string, self?: string): StateDependencyInfo {
  const sf = parseTypeScript('file.tsx', content, ts.ScriptKind.TSX);
  const bindings = reactBindings(sf);
  const dependencies = new Map<string, Dependency>();
  const items: StateDependencyItem[] = [];
  const diagnostics: NonNullable<StateDependencyInfo['diagnostics']> = [];
  const tracking = new Map<object, Array<{ dependency: Dependency; action: boolean; property?: string }>>();
  const seenItems = new Set<string>();
  const lines = content.split('\n');
  function add(kind: Dependency['kind'], identifier: string, method = 'react-hook-name', reason = 'Conventional dependency name; runtime identity and behavior are not verified.'): Dependency {
    const key = `${kind}:${identifier}`;
    if (!dependencies.has(key)) dependencies.set(key, { kind, identifier, evidence: { basis: 'derived', resolution: 'candidate', method, reason } });
    return dependencies.get(key)!;
  }
  function record(dependency: Dependency, node: ts.Node, accessMode: 'read' | 'write' = 'read', accessedProperties?: string[]): void {
    const lineNumber = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const existing = items.find(item => item.kind === dependency.kind && item.identifier === dependency.identifier && item.lineNumber === lineNumber && item.accessMode === accessMode);
    if (existing) {
      if (accessedProperties && accessedProperties.length > 0) {
        existing.accessedProperties = Array.from(new Set([...(existing.accessedProperties ?? []), ...accessedProperties]));
      }
      return;
    }
    const key = `${dependency.kind}:${dependency.identifier}:${lineNumber}:${accessMode}`;
    if (seenItems.has(key)) return;
    seenItems.add(key);
    items.push({ kind: dependency.kind, identifier: dependency.identifier, accessMode, lineNumber,
      usageSnippet: lines[lineNumber - 1]?.trim().slice(0, 80), evidence: dependency.evidence,
      ...(accessedProperties && accessedProperties.length > 0 ? { accessedProperties } : {}) });
  }
  function classify(identifier: ts.Identifier): Dependency | undefined {
    const value = bindings.binding(identifier);
    if (value && (!value.source || value.typeOnly)) return;
    const name = value?.imported ?? identifier.text;
    if (name === 'router' && /^@inertiajs\/(react|core)$/.test(value?.source ?? '')) return add('composable', identifier.text, 'inertia-router-import');
    if (value?.source === 'react' || identifier.text === self || BUILTINS.has(name) || name === 'useStore') return;
    if (REDUX.test(name) || STORE_HOOK.test(name)) return add('store', identifier.text);
    if (/^use[A-Z][A-Za-z0-9_$]*$/.test(name)) return add('composable', identifier.text);
  }
  function seed(call: ts.CallExpression, dependency: Dependency, name: string): void {
    let current: ts.Node = call;
    while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
      || ts.isAwaitExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
    if (!ts.isVariableDeclaration(current.parent) || current.parent.initializer !== current) return;
    const declaration = current.parent;
    const bind = (identifier: ts.Identifier, action: boolean, property?: string) => {
      const value = bindings.binding(identifier);
      if (value) tracking.set(value, [...(tracking.get(value) ?? []), { dependency, action, property }]);
    };
    if (ts.isIdentifier(declaration.name)) {
      const selector = call.arguments[0] && unwrapExpression(call.arguments[0]);
      let property: string | undefined;
      if (dependency.kind === 'store' && (name === 'useStore' || STORE_HOOK.test(name)) &&
        selector && ts.isArrowFunction(selector) && !ts.isBlock(selector.body)) {
        const parameter = selector.parameters[0]?.name;
        const projection = unwrapExpression(selector.body);
        if (parameter && ts.isIdentifier(parameter) && ts.isPropertyAccessExpression(projection) &&
          ts.isIdentifier(projection.expression) && projection.expression.text === parameter.text) {
          property = projection.name.text;
        }
      }
      bind(declaration.name, name === 'useSetAtom' || /Dispatch$/.test(name) || !!property && ACTION.test(property), property);
    }
    else for (const [index, element] of declaration.name.elements.entries()) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      const field = element.propertyName?.getText(sf) ?? element.name.text;
      bind(element.name, ts.isArrayBindingPattern(declaration.name) ? index === 1 : ACTION.test(field));
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isImportSpecifier(node) && !node.isTypeOnly) {
      const dependency = classify(node.name);
      if (dependency) {
        record(dependency, node);
        if (dependency.evidence.method === 'inertia-router-import') {
          const value = bindings.binding(node.name);
          if (value) tracking.set(value, [{ dependency, action: false }]);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const imported = bindings.imported(node.expression);
      const api = bindings.api(node.expression);
      const expression = unwrapExpression(node.expression);
      const direct = ts.isIdentifier(expression) ? expression : undefined;
      const local = direct ? bindings.binding(direct) : undefined;
      const name = imported?.imported ?? direct?.text ?? '';
      const arg = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
      let dependency: Dependency | undefined;
      if (api === 'useContext' && arg && (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg))) {
        dependency = add('context', arg.getText(sf), 'react-import-binding', 'Hook binding resolves to React; context object/provider identity remains unverified.');
      } else if (api === 'useContext') {
        diagnostics.push({ code: 'REACT_CONTEXT_ARGUMENT_UNRESOLVED', reason: 'React useContext needs a static context identifier/member for dependency-key extraction.' });
      } else if (api === 'use' && arg) {
        if (bindings.isLocalContext(arg)) dependency = add('context', arg.getText(sf), 'react-local-context', 'Resource is a local const created by React.createContext; provider identity is not proven.');
        else {
          diagnostics.push({ code: 'REACT_USE_RESOURCE_UNVERIFIED', reason: `use(${arg.getText(sf)}) may consume a promise or context; imported/resource identity is not resolved.` });
          if (ts.isIdentifier(arg) && bindings.binding(arg)?.source && /Context$/.test(arg.text))
            dependency = add('context', arg.text, 'react-use-context-name', 'Imported Context-suffixed resource is only a candidate; use also accepts promises.');
        }
      } else if (!api && (!local || local.source && !local.typeOnly)) {
        if (name === 'useStore' && arg && ts.isIdentifier(arg)) dependency = add('store', arg.text);
        else if (name === 'inject' && !local && arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg))) dependency = add('context', ts.isStringLiteralLike(arg) ? arg.text : arg.getText(sf), 'unbound-inject-name');
        else if (['useAtom', 'useAtomValue', 'useSetAtom'].includes(name) && arg && ts.isIdentifier(arg)
          && (!imported || /^jotai(?:\/|$)/.test(imported.source ?? ''))) dependency = add('store', arg.text, 'atom-hook-binding');
        else if (direct) dependency = classify(direct);
      }
      if (dependency) {
        const accessed: string[] = [];
        if (node.arguments[0]) {
          const arg0 = node.arguments[0];
          let fn: ts.ArrowFunction | ts.FunctionExpression | undefined;
          if (ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0)) fn = arg0;
          if (fn && fn.parameters.length > 0) {
            const firstParam = fn.parameters[0];
            if (ts.isIdentifier(firstParam.name)) {
              const paramName = firstParam.name.text;
              const scanParam = (n: ts.Node) => {
                if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === paramName) {
                  accessed.push(n.name.text);
                }
                ts.forEachChild(n, scanParam);
              };
              scanParam(fn.body);
            } else if (ts.isObjectBindingPattern(firstParam.name)) {
              for (const el of firstParam.name.elements) {
                if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                  accessed.push(el.propertyName?.getText(sf) ?? el.name.text);
                }
              }
            }
          }
        }
        let currentParent: ts.Node = node;
        while (ts.isParenthesizedExpression(currentParent.parent) || ts.isAsExpression(currentParent.parent) || ts.isSatisfiesExpression(currentParent.parent) || ts.isAwaitExpression(currentParent.parent) || ts.isNonNullExpression(currentParent.parent)) currentParent = currentParent.parent;
        if (ts.isVariableDeclaration(currentParent.parent) && ts.isObjectBindingPattern(currentParent.parent.name)) {
          for (const el of currentParent.parent.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              accessed.push(el.propertyName?.getText(sf) ?? el.name.text);
            }
          }
        }
        const uniqueAccessed = Array.from(new Set(accessed));
        record(dependency, node, 'read', uniqueAccessed.length > 0 ? uniqueAccessed : undefined);
        seed(node, dependency, name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  function uses(node: ts.Node): void {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const declarationName = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node;
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ts.isPropertyAssignment(parent) && parent.name === node || ts.isBindingElement(parent) && parent.propertyName === node;
      if (!declarationName && !propertyName) {
        const value = bindings.binding(node);
        for (const tracked of value ? tracking.get(value) ?? [] : []) {
          let access: ts.Node = node;
          while ((ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) && access.parent.expression === access) access = access.parent;
          const method = ts.isPropertyAccessExpression(access) ? access.name.text
            : ts.isElementAccessExpression(access) && access.argumentExpression && ts.isStringLiteralLike(access.argumentExpression)
              ? access.argumentExpression.text : undefined;
          const write = ts.isCallExpression(access.parent) && access.parent.expression === access
            && (access === node ? tracked.action : !method || !COLLECTION_READS.has(method))
            || ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            || (ts.isPrefixUnaryExpression(access.parent) || ts.isPostfixUnaryExpression(access.parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(access.parent.operator);
          const property = tracked.property ?? method;
          record(tracked.dependency, node, write ? 'write' : 'read', property ? [property] : undefined);
        }
      }
    }
    ts.forEachChild(node, uses);
  }
  uses(sf);
  const values = [...dependencies.values()];
  return { stores: values.filter(item => item.kind === 'store').map(item => item.identifier),
    contexts: values.filter(item => item.kind === 'context').map(item => item.identifier),
    composables: values.filter(item => item.kind === 'composable').map(item => item.identifier), items,
    ...(diagnostics.length ? { diagnostics } : {}) };
}
