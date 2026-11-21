import { parseTypeScript } from '../source-parser';
import ts from 'typescript';

/** Remove syntax-only wrappers without evaluating expressions or resolving identifiers. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

export function findDirective(statements: ts.NodeArray<ts.Statement>, value: string): ts.StringLiteral | undefined {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === value) return statement.expression;
  }
  return undefined;
}

export function moduleDirective(content: string, value: string): ts.StringLiteral | undefined {
  const source = parseTypeScript('module.tsx', content, ts.ScriptKind.TSX);
  return findDirective(source.statements, value);
}

export function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
  }
  return undefined;
}

export function callableName(node: ts.Node): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(node) && node.body) return node.name;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
    (node.parent.flags & ts.NodeFlags.Const) &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name;
}
