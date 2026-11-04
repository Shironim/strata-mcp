import { basename, dirname, extname } from 'node:path';
import ts from 'typescript';
import { extractStyleTokens } from '../contract';
import { unwrapExpression, staticPropertyName } from './ts-syntax';
import { resolveLocalPropType } from './local-prop-types';
import { PropTypeModules } from './prop-type-modules';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentPropContract,
  ComponentSlotDetail,
  UnresolvedTypeInfo,
  InputDependency,
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
  declaredFunctions: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>,
  declaredVariables: Map<string, ts.VariableDeclaration>,
  wrappers: Map<string, string>,
  namespaces: Set<string>,
): UnwrappedComponent {
  let current: ts.Expression = expr;
  let isForwardRef = false;
  let isMemo = false;
  let refType: ts.TypeNode | undefined;
  let propsType: ts.TypeNode | undefined;
  const visited = new Set<string>();

  while (true) {
    current = unwrapExpression(current);
    if (ts.isIdentifier(current) && declaredVariables.has(current.text)) {
      if (visited.has(current.text)) break;
      visited.add(current.text);
      const initializer = declaredVariables.get(current.text)!.initializer;
      if (!initializer) break;
      current = initializer;
      continue;
    }
    if (!ts.isCallExpression(current)) break;

    let calleeName = '';
    if (ts.isIdentifier(current.expression)) {
      calleeName = wrappers.get(current.expression.text) ?? '';
    } else if (ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression) && namespaces.has(current.expression.expression.text)) {
      calleeName = current.expression.name.text;
    }

    if (calleeName === 'memo') {
      if (!current.arguments[0]) break;
      isMemo = true;
      propsType ??= current.typeArguments?.[0];
      current = current.arguments[0];
    } else if (calleeName === 'forwardRef') {
      if (!current.arguments[0]) break;
      isForwardRef = true;
      if (current.typeArguments && current.typeArguments.length > 0) {
        if (current.typeArguments.length >= 2) {
          refType = current.typeArguments[0];
          propsType = current.typeArguments[1];
        } else refType = current.typeArguments[0];
      }
      current = current.arguments[0];
    } else {
      break;
    }
  }

  current = unwrapExpression(current);

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
        const name = element.propertyName ? staticPropertyName(element.propertyName) : element.name.text;
        if (name !== undefined) defaults.set(name, element.initializer.getText(sf).trim());
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


export async function extractReactContract(filePath: string, content: string, workspaceRoot = dirname(filePath)): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  const slots: string[] = [];
  const slotDetails: ComponentSlotDetail[] = [];
  let exposed: string[] = [];
  const unresolvedTypes: UnresolvedTypeInfo[] = [];
  let dependencies: InputDependency[] = [];

  try {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
    const declaredFunctions = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
    const declaredVariables = new Map<string, ts.VariableDeclaration>();
    const wrappers = new Map<string, string>();
    const namespaces = new Set<string>();
    let defaultExport: ts.FunctionDeclaration | ts.Expression | undefined;

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === 'react' && !stmt.importClause?.isTypeOnly) {
        const clause = stmt.importClause;
        if (clause?.name) namespaces.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (!binding.isTypeOnly && ['memo', 'forwardRef'].includes(name)) wrappers.set(binding.name.text, name);
        }
      }
      if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
        declaredTypes.set(stmt.name.text, stmt);
      }
      if (ts.isFunctionDeclaration(stmt)) {
        if (stmt.name) declaredFunctions.set(stmt.name.text, stmt);
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
          const unwrapped = unwrapHoc(targetComponentDecl.initializer, declaredFunctions, declaredVariables, wrappers, namespaces);
          targetFnNode = unwrapped.fnNode;
          if (unwrapped.propsType) targetPropsType = unwrapped.propsType;
        }
      } else if (ts.isFunctionDeclaration(targetComponentDecl)) {
        targetFnNode = targetComponentDecl;
      } else if (ts.isArrowFunction(targetComponentDecl) || ts.isFunctionExpression(targetComponentDecl)) {
        targetFnNode = targetComponentDecl;
      } else {
        const unwrapped = unwrapHoc(targetComponentDecl, declaredFunctions, declaredVariables, wrappers, namespaces);
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
    if (targetComponentDecl && !targetFnNode) unresolvedTypes.push({ name: component, kind: 'props', reason: 'Component expression or wrapper could not be resolved to a local React function.' });

    const modules = new PropTypeModules(workspaceRoot);
    if (targetPropsType || targetFnNode) await modules.prepare(sf);
    dependencies = [...modules.dependencies.values()];
    if (targetFnNode?.typeParameters?.length) unresolvedTypes.push({ name: component, kind: 'props', reason: 'Component-level generic arguments are unbound at declaration inspection.' });
    if (targetPropsType) {
      resolveLocalPropType(targetPropsType, sf, declaredTypes, defaults, propsMap, unresolvedTypes, new Set(), { lookup: modules.lookup });
    } else {
      // Fallback conventional Props interface or type
      const fallbackDecl = declaredTypes.get(`${component}Props`) ?? declaredTypes.get('Props');
      if (fallbackDecl && targetFnNode) {
        resolveLocalPropType(fallbackDecl, sf, declaredTypes, defaults, propsMap, unresolvedTypes, new Set(), { lookup: modules.lookup });
      }
    }

    for (const reason of modules.diagnostics) unresolvedTypes.push({ name: component, kind: 'props', reason });

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
    ...(unresolvedTypes.length ? { unresolvedTypes } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    styleTokens: extractStyleTokens(content),
  };
}

/**
 * Extracts Astro component contract from .astro source code.
 */
