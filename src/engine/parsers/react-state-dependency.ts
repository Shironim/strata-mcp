import ts from 'typescript';
import type { Evidence, StateDependencyInfo, StateDependencyItem } from '../../types';
import { reactBindings } from './react-bindings';
import { unwrapExpression } from './ts-syntax';

const BUILTINS = new Set(['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useId', 'useContext', 'useReducer',
  'useTransition', 'useDeferredValue', 'useImperativeHandle', 'useLayoutEffect', 'useInsertionEffect', 'useSyncExternalStore', 'useActionState', 'useOptimistic']);
const REDUX = /^(useSelector|useDispatch|useAppSelector|useAppDispatch)$/;
const ACTION = /^(set|update|delete|add|remove|open|close|mutate|trigger|toggle|reset|dispatch|handle|submit|checkout)/i;
interface Dependency { kind: StateDependencyItem['kind']; identifier: string; evidence: Evidence }

export function extractReactStateDependencies(content: string, self?: string): StateDependencyInfo {
  const sf = ts.createSourceFile('file.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = reactBindings(sf);
  const dependencies = new Map<string, Dependency>();
  const items: StateDependencyItem[] = [];
  const diagnostics: NonNullable<StateDependencyInfo['diagnostics']> = [];
  const tracking = new Map<object, Array<{ dependency: Dependency; action: boolean }>>();
  const seenItems = new Set<string>();
  const lines = content.split('\n');
  function add(kind: Dependency['kind'], identifier: string, method = 'react-hook-name', reason = 'Conventional dependency name; runtime identity and behavior are not verified.'): Dependency {
    const key = `${kind}:${identifier}`;
    if (!dependencies.has(key)) dependencies.set(key, { kind, identifier, evidence: { basis: 'derived', resolution: 'candidate', method, reason } });
    return dependencies.get(key)!;
  }
  function record(dependency: Dependency, node: ts.Node, accessMode: 'read' | 'write' = 'read'): void {
    const lineNumber = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const key = `${dependency.kind}:${dependency.identifier}:${lineNumber}:${accessMode}`;
    if (seenItems.has(key)) return;
    seenItems.add(key);
    items.push({ kind: dependency.kind, identifier: dependency.identifier, accessMode, lineNumber,
      usageSnippet: lines[lineNumber - 1]?.trim().slice(0, 80), evidence: dependency.evidence });
  }
  function classify(identifier: ts.Identifier): Dependency | undefined {
    const value = bindings.binding(identifier);
    if (value && (!value.source || value.typeOnly)) return;
    const name = value?.imported ?? identifier.text;
    if (name === 'router' && /^@inertiajs\/(react|core)$/.test(value?.source ?? '')) return add('composable', identifier.text, 'inertia-router-import');
    if (value?.source === 'react' || identifier.text === self || BUILTINS.has(name) || name === 'useStore') return;
    if (REDUX.test(name) || /^use[A-Za-z0-9_$]*Store$/.test(name)) return add('store', identifier.text);
    if (/^use[A-Z][A-Za-z0-9_$]*$/.test(name)) return add('composable', identifier.text);
  }
  function seed(call: ts.CallExpression, dependency: Dependency, name: string): void {
    let current: ts.Node = call;
    while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
      || ts.isAwaitExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
    if (!ts.isVariableDeclaration(current.parent) || current.parent.initializer !== current) return;
    const declaration = current.parent;
    const bind = (identifier: ts.Identifier, action: boolean) => {
      const value = bindings.binding(identifier);
      if (value) tracking.set(value, [...(tracking.get(value) ?? []), { dependency, action }]);
    };
    if (ts.isIdentifier(declaration.name)) bind(declaration.name, name === 'useSetAtom' || /Dispatch$/.test(name));
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
      if (dependency) { record(dependency, node); seed(node, dependency, name); }
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
          const write = ts.isCallExpression(access.parent) && access.parent.expression === access && (tracked.action || access !== node)
            || ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            || (ts.isPrefixUnaryExpression(access.parent) || ts.isPostfixUnaryExpression(access.parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(access.parent.operator);
          record(tracked.dependency, node, write ? 'write' : 'read');
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
