import ts from 'typescript';
import { staticPropertyName } from './ts-syntax';
import type { ComponentPropContract, UnresolvedTypeInfo } from '../../types';

export interface PropTypeOwner {
  sf: ts.SourceFile;
  declaredTypes: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>;
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
}
interface BoundType {
  node: ts.TypeNode;
  sf: ts.SourceFile;
  declaredTypes: PropTypeOwner['declaredTypes'];
  bindings: Map<string, BoundType>;
}
export interface PropTypeResolution {
  lookup?: (sf: ts.SourceFile, name: string) => PropTypeOwner | undefined;
  bindings?: Map<string, BoundType>;
  arguments?: BoundType[];
  depth?: number;
}

function typeText(node: ts.TypeNode, sf: ts.SourceFile, bindings: Map<string, BoundType>, depth = 0): string {
  const text = node.getText(sf);
  if (!bindings.size || depth > 32) return text;
  const replacements: { start: number; end: number; text: string }[] = [];
  function visit(current: ts.Node, shadowed: Set<string>): void {
    const parameters = (current as ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
    if (parameters?.length) shadowed = new Set([...shadowed, ...parameters.map(parameter => parameter.name.text)]);
    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName) && !current.typeArguments?.length
      && !shadowed.has(current.typeName.text)) {
      const bound = bindings.get(current.typeName.text);
      if (bound) {
        let value = typeText(bound.node, bound.sf, bound.bindings, depth + 1);
        if (/[|&]/.test(value)) value = `(${value})`;
        replacements.push({ start: current.getStart(sf) - node.getStart(sf), end: current.end - node.getStart(sf), text: value });
        return;
      }
    }
    ts.forEachChild(current, child => visit(child, shadowed));
  }
  visit(node, new Set());
  return replacements.sort((a, b) => b.start - a.start).reduce((result, replacement) =>
    result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end), text);
}

function extractJsDocInfo(node: ts.Node): { description?: string; deprecated?: boolean | string } {
  let description: string | undefined;
  let deprecated: boolean | string | undefined;

  const jsDocList: any[] = (node as any).jsDoc || (ts.getJSDocCommentsAndTags ? ts.getJSDocCommentsAndTags(node) : []);
  for (const doc of jsDocList) {
    if (doc.comment && !description) {
      if (typeof doc.comment === 'string') {
        description = doc.comment.trim().split('\n')[0].trim();
      } else if (Array.isArray(doc.comment)) {
        description = doc.comment.map((c: any) => c.text || '').join('').trim().split('\n')[0].trim();
      }
    }
    if (doc.tags) {
      for (const tag of doc.tags) {
        const tagName = tag.tagName?.text;
        if (tagName === 'deprecated') {
          if (tag.comment) {
            deprecated = typeof tag.comment === 'string'
              ? tag.comment.trim()
              : Array.isArray(tag.comment)
                ? tag.comment.map((c: any) => c.text || '').join('').trim()
                : true;
          } else {
            deprecated = true;
          }
        }
      }
    }
  }

  return { description, deprecated };
}

function extractPropertyFromSignature(
  member: ts.TypeElement,
  sf: ts.SourceFile,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>,
  bindings = new Map<string, BoundType>(),
): void {
  if (!ts.isPropertySignature(member) || !member.name) return;
  const name = staticPropertyName(member.name);
  if (name === undefined) return;
  const isOptional = Boolean(member.questionToken);
  const text = member.type ? typeText(member.type, sf, bindings).trim() : 'any';
  const defaultVal = defaults.get(name);
  const required = !isOptional && defaultVal === undefined;

  let isUnion: boolean | undefined;
  let unionMembers: string[] | undefined;
  if (member.type && ts.isUnionTypeNode(member.type)) {
    isUnion = true;
    unionMembers = member.type.types.map(t => typeText(t, sf, bindings).trim()).filter(Boolean);
  }

  const jsDoc = extractJsDocInfo(member);

  propsMap.set(name, {
    name,
    type: text,
    required,
    ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    ...(isUnion && unionMembers && unionMembers.length > 1 ? { isUnion, unionMembers } : {}),
    ...(jsDoc.description ? { description: jsDoc.description } : {}),
    ...(jsDoc.deprecated !== undefined ? { deprecated: jsDoc.deprecated } : {}),
  });
}

export function resolveLocalPropType(
  typeNode: ts.TypeNode | ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  declaredTypes: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>,
  unresolved: UnresolvedTypeInfo[],
  visited = new Set<string>(),
  resolution: PropTypeResolution = {},
): void {
  const unknown = (name: string, reason: string) => {
    if (!unresolved.some(item => item.name === name && item.reason === reason)) unresolved.push({ name, kind: 'props', reason });
  };
  if ((resolution.depth ?? 0) > 40) { unknown(typeNode.getText(sf), 'Prop type traversal limit reached.'); return; }
  const bindings = resolution.bindings ?? new Map<string, BoundType>();
  const descend = (node: typeof typeNode, output = propsMap, next = resolution) =>
    resolveLocalPropType(node, sf, declaredTypes, defaults, output, unresolved, new Set(visited), { ...next, depth: (resolution.depth ?? 0) + 1 });
  const reference = (name: string, args: readonly ts.TypeNode[] = []): boolean => {
    const local = declaredTypes.get(name);
    const owner = local ? { sf, declaredTypes, declaration: local } : resolution.lookup?.(sf, name);
    if (!owner) return false;
    if (args.length > (owner.declaration.typeParameters?.length ?? 0)) {
      unknown(name, 'Generic argument count exceeds the declared type parameters.'); return true;
    }
    resolveLocalPropType(owner.declaration, owner.sf, owner.declaredTypes, defaults, propsMap, unresolved, new Set(visited), {
      ...resolution, bindings: new Map(), arguments: args.map(node => ({ node, sf, declaredTypes, bindings })), depth: (resolution.depth ?? 0) + 1,
    });
    return true;
  };
  const collectMembers = (members: ts.NodeArray<ts.TypeElement>) => {
    for (const member of members) {
      extractPropertyFromSignature(member, sf, defaults, propsMap, bindings);
      if (!ts.isPropertySignature(member) || (member.name && staticPropertyName(member.name) === undefined))
        unknown(member.getText(sf), 'Non-property or dynamic type member is not resolved.');
    }
  };
  if (ts.isInterfaceDeclaration(typeNode) || ts.isTypeAliasDeclaration(typeNode)) {
    const name = `${sf.fileName}:${typeNode.name.text}`;
    if (visited.has(name)) { unknown(name, 'Recursive local prop type is not fully resolved.'); return; }
    if (typeNode.typeParameters?.length) {
      if (!resolution.lookup) { unknown(name, 'Generic prop substitution is not supported by the local syntax resolver.'); return; }
      for (const [index, parameter] of typeNode.typeParameters.entries()) {
        if (parameter.constraint) unknown(parameter.name.text, 'Generic constraints require TypeScript assignability checking.');
        const bound = resolution.arguments?.[index] ?? (parameter.default ? { node: parameter.default, sf, declaredTypes, bindings: new Map(bindings) } : undefined);
        if (!bound) { unknown(parameter.name.text, 'Generic prop argument is unbound.'); return; }
        bindings.set(parameter.name.text, bound);
      }
    }
    const next = { ...resolution, bindings, arguments: undefined };
    visited.add(name);
    if (ts.isTypeAliasDeclaration(typeNode)) { descend(typeNode.type, propsMap, next); return; }
    for (const clause of typeNode.heritageClauses ?? []) {
      for (const base of clause.types) {
        const name = base.expression.getText(sf);
        if (!reference(name, base.typeArguments)) {
          if (name === 'VariantProps' || name.endsWith('.VariantProps')) {
            if (extractCvaVariantsFromType(base as any, sf, defaults, propsMap)) {
              continue;
            }
          }
          unknown(base.getText(sf), 'Inherited prop type requires external or generic type resolution.');
        }
      }
    }
    collectMembers(typeNode.members);
    return;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) { descend(typeNode.type); return; }
  if (ts.isTypeLiteralNode(typeNode)) {
    collectMembers(typeNode.members);
    return;
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) descend(member);
    return;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText(sf);
    const bound = bindings.get(name);
    if (bound && !typeNode.typeArguments?.length) {
      resolveLocalPropType(bound.node, bound.sf, bound.declaredTypes, defaults, propsMap, unresolved, new Set(visited), {
        ...resolution, bindings: bound.bindings, arguments: undefined, depth: (resolution.depth ?? 0) + 1,
      });
      return;
    }
    if (reference(name, typeNode.typeArguments)) return;
    if (name === 'VariantProps' || name.endsWith('.VariantProps')) {
      if (extractCvaVariantsFromType(typeNode, sf, defaults, propsMap)) {
        return;
      }
    }
    const imported = sf.statements.filter(ts.isImportDeclaration).some(statement => {
      const clause = statement.importClause;
      if (clause?.name?.text === name) return true;
      const bindings = clause?.namedBindings;
      return bindings && (ts.isNamespaceImport(bindings) ? name.startsWith(`${bindings.name.text}.`)
        : bindings.elements.some(binding => binding.name.text === name));
    });
    if (imported) { unknown(name, 'Imported prop type requires external resolution.'); return; }
    const args = typeNode.typeArguments ?? [];
    const unary = ['Partial', 'Required', 'Readonly'].includes(name) && args.length === 1;
    const filter = ['Pick', 'Omit'].includes(name) && args.length === 2;
    if (unary || filter) {
      const selected = new Map<string, ComponentPropContract>();
      descend(args[0], selected);
      let keys: Set<string> | undefined;
      if (filter) {
        const keyType = ts.isParenthesizedTypeNode(args[1]) ? args[1].type : args[1];
        const members = ts.isUnionTypeNode(keyType) ? keyType.types : [keyType];
        if (!members.every(member => ts.isLiteralTypeNode(member) && (ts.isStringLiteral(member.literal) || ts.isNumericLiteral(member.literal)))) {
          unknown(typeNode.getText(sf), 'Pick/Omit keys must be literal names; computed key sets are not resolved.'); return;
        }
        keys = new Set(members.map(member => ((member as ts.LiteralTypeNode).literal as ts.StringLiteral | ts.NumericLiteral).text));
      }
      for (const [key, prop] of selected) {
        if (keys && (name === 'Pick' ? !keys.has(key) : keys.has(key))) continue;
        propsMap.set(key, { ...prop, ...(name === 'Partial' ? { required: false } : name === 'Required' ? { required: !defaults.has(key) } : {}) });
      }
      return;
    }
  }
  unknown(typeNode.getText(sf), 'Prop shape requires external, conditional, mapped, union or unsupported type resolution.');
}

export function extractCvaVariantsFromType(
  typeNode: ts.TypeReferenceNode,
  sf: ts.SourceFile,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>
): boolean {
  if (!typeNode.typeArguments || typeNode.typeArguments.length === 0) return false;
  const arg = typeNode.typeArguments[0];
  let varName: string | undefined;
  if (ts.isTypeQueryNode(arg) && ts.isIdentifier(arg.exprName)) {
    varName = arg.exprName.text;
  } else if (ts.isTypeReferenceNode(arg) && ts.isIdentifier(arg.typeName)) {
    varName = arg.typeName.text;
  }
  if (!varName) return false;
  return extractCvaVariants(varName, sf, defaults, propsMap);
}

export function extractCvaVariants(
  varName: string,
  sf: ts.SourceFile,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>
): boolean {
  let matched = false;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== varName) continue;
      if (!decl.initializer) continue;
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (!ts.isCallExpression(init)) continue;

      let configObj: ts.ObjectLiteralExpression | undefined;
      for (const arg of init.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          configObj = arg;
          break;
        }
      }
      if (!configObj) continue;

      const defaultVariantsMap = new Map<string, string>();
      for (const prop of configObj.properties) {
        if (ts.isPropertyAssignment(prop) && prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          const propKey = prop.name.text;
          if (propKey === 'defaultVariants' && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const defProp of prop.initializer.properties) {
              if (ts.isPropertyAssignment(defProp) && defProp.name && (ts.isIdentifier(defProp.name) || ts.isStringLiteral(defProp.name))) {
                if (ts.isStringLiteral(defProp.initializer)) {
                  defaultVariantsMap.set(defProp.name.text, `"${defProp.initializer.text}"`);
                } else if (ts.isIdentifier(defProp.initializer) || ts.isNumericLiteral(defProp.initializer)) {
                  defaultVariantsMap.set(defProp.name.text, defProp.initializer.getText(sf));
                }
              }
            }
          }
        }
      }

      for (const prop of configObj.properties) {
        if (ts.isPropertyAssignment(prop) && prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          const propKey = prop.name.text;
          if (propKey === 'variants' && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const variantGroup of prop.initializer.properties) {
              if (ts.isPropertyAssignment(variantGroup) && variantGroup.name && (ts.isIdentifier(variantGroup.name) || ts.isStringLiteral(variantGroup.name))) {
                const variantName = variantGroup.name.text;
                if (ts.isObjectLiteralExpression(variantGroup.initializer)) {
                  const options: string[] = [];
                  for (const opt of variantGroup.initializer.properties) {
                    if (opt.name && (ts.isIdentifier(opt.name) || ts.isStringLiteral(opt.name))) {
                      options.push(opt.name.text);
                    }
                  }
                  if (options.length > 0) {
                    matched = true;
                    const defaultVal = defaults.get(variantName) ?? defaultVariantsMap.get(variantName);
                    const isUnion = options.length > 1;
                    propsMap.set(variantName, {
                      name: variantName,
                      type: options.map(o => `"${o}"`).join(' | '),
                      required: false,
                      ...(defaultVal !== undefined ? { default: defaultVal } : {}),
                      ...(isUnion ? { isUnion: true, unionMembers: options } : {}),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return matched;
}

