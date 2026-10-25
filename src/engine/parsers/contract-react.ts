import { basename, extname } from 'node:path';
import ts from 'typescript';
import { extractStyleTokens } from '../contract';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentPropContract,
  ComponentSlotDetail,
} from '../../types';

const REACT_EVENT_HANDLER_PATTERN = /^on[A-Z]/;

/** Reports whether a React prop name is an event callback (`onXxx`). */
function isReactEventHandler(propName: string): boolean {
  return REACT_EVENT_HANDLER_PATTERN.test(propName);
}

interface UnwrappedComponent {
  fnNode?: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  refType?: ts.TypeNode;
  propsType?: ts.TypeNode;
  isForwardRef?: boolean;
  isMemo?: boolean;
}

function unwrapHoc(
  expr: ts.Expression,
  declaredFunctions: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>
): UnwrappedComponent {
  let current: ts.Expression = expr;
  let isForwardRef = false;
  let isMemo = false;
  let refType: ts.TypeNode | undefined;
  let propsType: ts.TypeNode | undefined;

  while (true) {
    while (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    if (!ts.isCallExpression(current)) break;

    let calleeName = '';
    if (ts.isIdentifier(current.expression)) {
      calleeName = current.expression.text;
    } else if (ts.isPropertyAccessExpression(current.expression)) {
      calleeName = current.expression.name.text;
    }

    if (calleeName === 'memo') {
      isMemo = true;
      current = current.arguments[0];
    } else if (calleeName === 'forwardRef') {
      isForwardRef = true;
      if (current.typeArguments && current.typeArguments.length > 0) {
        if (current.typeArguments.length >= 2) {
          refType = current.typeArguments[0];
          propsType = current.typeArguments[1];
        } else {
          propsType = current.typeArguments[0];
        }
      }
      current = current.arguments[0];
    } else {
      break;
    }
  }

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return { fnNode: current, refType, propsType, isForwardRef, isMemo };
  }

  if (ts.isIdentifier(current) && declaredFunctions.has(current.text)) {
    return { fnNode: declaredFunctions.get(current.text), refType, propsType, isForwardRef, isMemo };
  }

  return { refType, propsType, isForwardRef, isMemo };
}

function extractParameterDefaults(param: ts.ParameterDeclaration, sf: ts.SourceFile): Map<string, string> {
  const defaults = new Map<string, string>();
  if (ts.isObjectBindingPattern(param.name)) {
    for (const element of param.name.elements) {
      if (ts.isIdentifier(element.name) && element.initializer) {
        defaults.set(element.name.text, element.initializer.getText(sf).trim());
      }
    }
  }
  return defaults;
}

function extractExposedMethods(fnNode: ts.Node): string[] {
  const exposed: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      let callName = '';
      if (ts.isIdentifier(node.expression)) callName = node.expression.text;
      else if (ts.isPropertyAccessExpression(node.expression)) callName = node.expression.name.text;

      if (callName === 'useImperativeHandle' && node.arguments.length >= 2) {
        let factoryArg = node.arguments[1];
        while (ts.isParenthesizedExpression(factoryArg)) {
          factoryArg = factoryArg.expression;
        }

        let objLiteral: ts.ObjectLiteralExpression | undefined;
        if (ts.isArrowFunction(factoryArg) || ts.isFunctionExpression(factoryArg)) {
          let factoryBody: ts.Node = factoryArg.body;
          while (ts.isParenthesizedExpression(factoryBody)) {
            factoryBody = factoryBody.expression;
          }

          if (ts.isObjectLiteralExpression(factoryBody)) {
            objLiteral = factoryBody;
          } else if (ts.isBlock(factoryBody)) {
            for (const stmt of factoryBody.statements) {
              if (ts.isReturnStatement(stmt) && stmt.expression) {
                let retExpr: ts.Expression = stmt.expression;
                while (ts.isParenthesizedExpression(retExpr)) {
                  retExpr = retExpr.expression;
                }
                if (ts.isObjectLiteralExpression(retExpr)) {
                  objLiteral = retExpr;
                  break;
                }
              }
            }
          }
        }
        if (objLiteral) {
          for (const prop of objLiteral.properties) {
            if (prop.name && ts.isIdentifier(prop.name)) {
              exposed.push(prop.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fnNode);
  return exposed;
}

function extractPropertyFromSignature(
  member: ts.TypeElement,
  sf: ts.SourceFile,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>
): void {
  if (!ts.isPropertySignature(member) || !member.name) return;
  const name = member.name.getText(sf).trim();
  const isOptional = Boolean(member.questionToken);
  const typeText = member.type ? member.type.getText(sf).trim() : 'any';
  const defaultVal = defaults.get(name);
  const required = !isOptional && defaultVal === undefined;

  let isUnion: boolean | undefined;
  let unionMembers: string[] | undefined;
  if (member.type && ts.isUnionTypeNode(member.type)) {
    isUnion = true;
    unionMembers = member.type.types.map(t => t.getText(sf).trim()).filter(Boolean);
  }

  propsMap.set(name, {
    name,
    type: typeText,
    required,
    ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    ...(isUnion && unionMembers && unionMembers.length > 1 ? { isUnion, unionMembers } : {}),
  });
}

function resolveTypeProperties(
  typeNode: ts.TypeNode | ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  declaredTypes: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>,
  defaults: Map<string, string>,
  propsMap: Map<string, ComponentPropContract>,
  visited = new Set<string>()
): void {
  if (ts.isInterfaceDeclaration(typeNode)) {
    if (visited.has(typeNode.name.text)) return;
    visited.add(typeNode.name.text);

    // Check heritage clauses (extends BaseProps)
    if (typeNode.heritageClauses) {
      for (const clause of typeNode.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const typeExpr of clause.types) {
            const baseName = typeExpr.expression.getText(sf).trim();
            const baseDecl = declaredTypes.get(baseName);
            if (baseDecl) {
              resolveTypeProperties(baseDecl, sf, declaredTypes, defaults, propsMap, visited);
            }
          }
        }
      }
    }

    for (const member of typeNode.members) {
      extractPropertyFromSignature(member, sf, defaults, propsMap);
    }
    return;
  }

  if (ts.isTypeAliasDeclaration(typeNode)) {
    if (visited.has(typeNode.name.text)) return;
    visited.add(typeNode.name.text);
    resolveTypeProperties(typeNode.type, sf, declaredTypes, defaults, propsMap, visited);
    return;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    for (const member of typeNode.members) {
      extractPropertyFromSignature(member, sf, defaults, propsMap);
    }
    return;
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      resolveTypeProperties(member, sf, declaredTypes, defaults, propsMap, visited);
    }
    return;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf).trim();
    const resolved = declaredTypes.get(typeName);
    if (resolved) {
      resolveTypeProperties(resolved, sf, declaredTypes, defaults, propsMap, visited);
    }
  }
}

export async function extractReactContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  const slots: string[] = [];
  const slotDetails: ComponentSlotDetail[] = [];
  let exposed: string[] = [];

  try {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
    const declaredFunctions = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
    const declaredVariables = new Map<string, ts.VariableDeclaration>();
    let defaultExport: ts.FunctionDeclaration | ts.Expression | undefined;

    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
        declaredTypes.set(stmt.name.text, stmt);
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        declaredFunctions.set(stmt.name.text, stmt);
        if (stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
          defaultExport = stmt;
        }
      }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            declaredVariables.set(decl.name.text, decl);
            if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              declaredFunctions.set(decl.name.text, decl.initializer);
            }
          }
        }
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        defaultExport = stmt.expression;
      }
    }

    // Determine target component node
    let targetComponentDecl: ts.FunctionDeclaration | ts.VariableDeclaration | ts.Expression | undefined;
    if (defaultExport) {
      if (ts.isIdentifier(defaultExport)) {
        targetComponentDecl = declaredVariables.get(defaultExport.text) ?? declaredFunctions.get(defaultExport.text);
      } else {
        targetComponentDecl = defaultExport;
      }
    }
    targetComponentDecl ??= declaredVariables.get(component) ?? declaredFunctions.get(component);
    if (!targetComponentDecl) {
      for (const [name, decl] of declaredVariables.entries()) {
        if (/^[A-Z]/.test(name)) {
          targetComponentDecl = decl;
          break;
        }
      }
    }
    if (!targetComponentDecl) {
      for (const [name, fn] of declaredFunctions.entries()) {
        if (/^[A-Z]/.test(name)) {
          targetComponentDecl = fn;
          break;
        }
      }
    }

    let targetFnNode: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
    let targetPropsType: ts.TypeNode | undefined;
    let defaults = new Map<string, string>();

    if (targetComponentDecl) {
      if (ts.isVariableDeclaration(targetComponentDecl)) {
        // Check React.FC<PropsType> annotation
        if (targetComponentDecl.type && ts.isTypeReferenceNode(targetComponentDecl.type)) {
          const typeName = targetComponentDecl.type.typeName.getText(sf);
          if (/^(React\.)?(FC|FunctionComponent)$/.test(typeName)) {
            targetPropsType = targetComponentDecl.type.typeArguments?.[0];
          }
        }

        if (targetComponentDecl.initializer) {
          const unwrapped = unwrapHoc(targetComponentDecl.initializer, declaredFunctions);
          targetFnNode = unwrapped.fnNode;
          if (unwrapped.propsType) targetPropsType = unwrapped.propsType;
        }
      } else if (ts.isFunctionDeclaration(targetComponentDecl)) {
        targetFnNode = targetComponentDecl;
      } else if (ts.isArrowFunction(targetComponentDecl) || ts.isFunctionExpression(targetComponentDecl)) {
        targetFnNode = targetComponentDecl;
      } else if (ts.isCallExpression(targetComponentDecl)) {
        const unwrapped = unwrapHoc(targetComponentDecl, declaredFunctions);
        targetFnNode = unwrapped.fnNode;
        if (unwrapped.propsType) targetPropsType = unwrapped.propsType;
      }
    }

    if (targetFnNode && targetFnNode.parameters.length > 0) {
      const firstParam = targetFnNode.parameters[0];
      defaults = extractParameterDefaults(firstParam, sf);
      if (!targetPropsType && firstParam.type) {
        targetPropsType = firstParam.type;
      }
      // Exposed methods via useImperativeHandle
      exposed = extractExposedMethods(targetFnNode);
    }

    const propsMap = new Map<string, ComponentPropContract>();

    if (targetPropsType) {
      resolveTypeProperties(targetPropsType, sf, declaredTypes, defaults, propsMap);
    } else {
      // Fallback conventional Props interface or type
      const fallbackDecl = declaredTypes.get(`${component}Props`) ?? declaredTypes.get('Props');
      if (fallbackDecl) {
        resolveTypeProperties(fallbackDecl, sf, declaredTypes, defaults, propsMap);
      }
    }

    // Process extracted props
    for (const p of propsMap.values()) {
      if (p.name === 'children') {
        if (!slots.includes('default')) slots.push('default');
        continue;
      }

      if (isReactEventHandler(p.name)) {
        emits.push({
          name: p.name,
          payload: p.type,
        });
      }

      // Detect Render Props / Slots
      const isSlotCandidate =
        /(?:ReactNode|ReactElement|JSX\.Element)/.test(p.type) ||
        (p.type.includes('=>') && /(?:ReactNode|ReactElement|JSX\.Element)/.test(p.type));

      if (isSlotCandidate && !p.name.startsWith('on')) {
        if (!slots.includes(p.name)) slots.push(p.name);
        slotDetails.push({
          name: p.name,
          isScoped: p.type.includes('=>'),
        });
      }

      props.push(p);
    }
  } catch {
    // Non-fatal AST fallback
  }

  // If no slots found yet, check if children is referenced in JSX
  if (slots.length === 0 && (content.includes('{children}') || content.includes('props.children'))) {
    slots.push('default');
  }

  return {
    component,
    framework: 'react',
    filePath,
    props,
    emits,
    slots,
    ...(slotDetails.length > 0 ? { slotDetails } : {}),
    ...(exposed.length > 0 ? { exposed } : {}),
    styleTokens: extractStyleTokens(content),
  };
}

/**
 * Extracts Astro component contract from .astro source code.
 */
