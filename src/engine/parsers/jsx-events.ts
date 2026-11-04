import ts from 'typescript';
import { unwrapExpression } from './ts-syntax';

/** Explicit host-element handler candidates; component props and spreads need separate resolution. */
export function jsxDomEventName(node: ts.Node): string | undefined {
  if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || !/^on[A-Z]/.test(node.name.text)) return;
  const owner = node.parent.parent;
  if (!ts.isJsxOpeningElement(owner) && !ts.isJsxSelfClosingElement(owner)) return;
  if (!ts.isIdentifier(owner.tagName) || !/^[a-z]/.test(owner.tagName.text) || owner.tagName.text.includes('-')) return;
  if (!node.initializer || !ts.isJsxExpression(node.initializer) || !node.initializer.expression) return;
  const value = unwrapExpression(node.initializer.expression);
  if (ts.isLiteralExpression(value) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword].includes(value.kind) || ts.isVoidExpression(value)) return;
  return node.name.text;
}
