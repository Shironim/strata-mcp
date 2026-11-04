import ts from 'typescript';
import { unwrapExpression } from './ts-syntax';

interface Binding {
  source?: string;
  imported?: string;
  declaration: ts.Node;
  typeOnly?: boolean;
}
interface Scope {
  parent?: Scope;
  functionScope: boolean;
  dynamic?: boolean;
  bindings: Map<string, Binding>;
}

/** Value bindings only. This does not follow mutable aliases or execute hook/context factories. */
export function reactBindings(sf: ts.SourceFile) {
  const scopes = new WeakMap<ts.Node, Scope>();
  const root: Scope = { functionScope: true, bindings: new Map() };
  function bind(name: ts.BindingName, scope: Scope, declaration: ts.Node): void {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, { declaration });
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope, declaration);
  }
  function visit(node: ts.Node, parent: Scope): void {
    let scope = parent;
    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) parent.bindings.set(node.name.text, { declaration: node });
      scope = { parent, functionScope: true, bindings: new Map() };
      if (ts.isFunctionExpression(node) && node.name) scope.bindings.set(node.name.text, { declaration: node });
      for (const parameter of node.parameters) bind(parameter.name, scope, parameter);
    } else if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isCatchClause(node) || ts.isCaseBlock(node) || ts.isClassLike(node) || ts.isWithStatement(node) || ts.isClassStaticBlockDeclaration(node)) {
      if (ts.isClassDeclaration(node) && node.name) parent.bindings.set(node.name.text, { declaration: node });
      const bodyScope = ts.isBlock(node) && ts.isFunctionLike(node.parent) && 'body' in node.parent && node.parent.body === node;
      scope = { parent, functionScope: bodyScope || ts.isClassStaticBlockDeclaration(node), bindings: new Map(), ...(ts.isWithStatement(node) ? { dynamic: true } : {}) };
      if (ts.isClassLike(node) && node.name) scope.bindings.set(node.name.text, { declaration: node });
    }
    scopes.set(node, scope);
    if (ts.isVariableDeclaration(node)) {
      let target = scope;
      if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        while (!target.functionScope && target.parent) target = target.parent;
      }
      bind(node.name, target, node);
    }
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const add = (local: string, imported: string, declaration: ts.Node, typeOnly = clause.isTypeOnly) =>
        scope.bindings.set(local, { source: (node.moduleSpecifier as ts.StringLiteral).text, imported, declaration, typeOnly });
      if (clause.name) add(clause.name.text, 'default', clause);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name.text, '*', clause.namedBindings);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements)
        add(binding.name.text, binding.propertyName?.text ?? binding.name.text, binding, clause.isTypeOnly || binding.isTypeOnly);
    }
    ts.forEachChild(node, child => visit(child, scope));
  }
  visit(sf, root);
  function binding(identifier: ts.Identifier): Binding | undefined {
    let scope = scopes.get(identifier);
    while (scope) {
      if (scope.dynamic) return { declaration: identifier };
      const value = scope.bindings.get(identifier.text);
      if (value) return value;
      scope = scope.parent;
    }
    return undefined;
  }
  function imported(raw: ts.Expression): Binding | undefined {
    const expression = unwrapExpression(raw);
    if (ts.isIdentifier(expression)) {
      const value = binding(expression);
      return value?.source && !value.typeOnly ? value : undefined;
    }
    let receiver: ts.Expression | undefined;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(expression)) { receiver = expression.expression; name = expression.name.text; }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(unwrapExpression(expression.argumentExpression))) {
      receiver = expression.expression;
      name = (unwrapExpression(expression.argumentExpression) as ts.StringLiteral).text;
    }
    if (receiver && name && ts.isIdentifier(unwrapExpression(receiver))) {
      const value = binding(unwrapExpression(receiver) as ts.Identifier);
      if (value?.source && !value.typeOnly && ['*', 'default'].includes(value.imported ?? '')) return { ...value, imported: name };
    }
    return undefined;
  }
  const api = (expression: ts.Expression): string | undefined => {
    const value = imported(expression);
    return value?.source === 'react' ? value.imported : undefined;
  };
  function isLocalContext(raw: ts.Expression): boolean {
    const expression = unwrapExpression(raw);
    if (!ts.isIdentifier(expression)) return false;
    const value = binding(expression);
    if (!value || !ts.isVariableDeclaration(value.declaration) || !value.declaration.initializer) return false;
    if (!ts.isVariableDeclarationList(value.declaration.parent) || !(value.declaration.parent.flags & ts.NodeFlags.Const)) return false;
    const initializer = unwrapExpression(value.declaration.initializer);
    return ts.isCallExpression(initializer) && api(initializer.expression) === 'createContext';
  }
  return { binding, imported, api, isLocalContext };
}
