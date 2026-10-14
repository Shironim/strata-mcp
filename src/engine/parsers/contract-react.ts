import { basename, extname } from 'node:path';
import ts from 'typescript';
import { executeAstGrep, isBinaryExecutionError } from '../astgrep';
import { extractPropertySignatures } from './contract-vue';
import { extractStyleTokens } from '../contract';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ContractOptions,
} from '../../types';

const REACT_EVENT_HANDLER_PATTERN = /^on[A-Z]/;


/** Reports whether a React prop name is an event callback (`onXxx`). */
function isReactEventHandler(propName: string): boolean {
  return REACT_EVENT_HANDLER_PATTERN.test(propName);
}

/**
 * Locates the TypeScript interface, type alias, or inline type literal for the entry React component
 * by inspecting component function parameters or React.FC type arguments.
 */
function findReactPropsSnippet(content: string, filePath: string, componentName: string): string | null {
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const components = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();
  let entry: ts.FunctionDeclaration | ts.VariableDeclaration | ts.Expression | undefined;
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) declaredTypes.set(stmt.name.text, stmt);
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) components.set(stmt.name.text, stmt);
      if (stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) entry = stmt;
    }
    if (ts.isVariableStatement(stmt)) for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) components.set(decl.name.text, decl);
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) entry = stmt.expression;
  }
  if (entry && ts.isIdentifier(entry)) entry = components.get(entry.text);
  entry ??= components.get(componentName);
  let targetType: ts.TypeNode | undefined;
  if (entry && ts.isVariableDeclaration(entry)) {
    if (entry.type && ts.isTypeReferenceNode(entry.type) && /^(React\.)?(FC|FunctionComponent)$/.test(entry.type.typeName.getText(sf))) targetType = entry.type.typeArguments?.[0];
    if (entry.initializer && (ts.isArrowFunction(entry.initializer) || ts.isFunctionExpression(entry.initializer))) targetType = entry.initializer.parameters[0]?.type ?? targetType;
  } else if (entry && (ts.isFunctionDeclaration(entry) || ts.isArrowFunction(entry) || ts.isFunctionExpression(entry))) targetType = entry.parameters[0]?.type;
  if (targetType) {
    if (ts.isTypeReferenceNode(targetType)) return declaredTypes.get(targetType.typeName.getText(sf))?.getText(sf) ?? null;
    if (ts.isTypeLiteralNode(targetType)) return `type Props = ${targetType.getText(sf)}`;
    return null;
  }
  // Retain conventional untyped-component declarations without matching suffixes of unrelated names.
  return (declaredTypes.get(`${componentName}Props`) ?? declaredTypes.get('Props'))?.getText(sf) ?? null;
}

export async function extractReactContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  const slots: string[] = [];

  // Search for Props interface or type using TypeScript AST resolution
  try {
    const propsSnippet = findReactPropsSnippet(content, filePath, component);
    if (propsSnippet) {
      const extracted = await extractPropertySignatures(propsSnippet, 'tsx');
      for (const p of extracted) {
        if (p.name === 'children') {
          slots.push('default');
          continue;
        }

        // In React, props starting with 'on' followed by uppercase letter are event callbacks
        if (isReactEventHandler(p.name)) {
          emits.push({
            name: p.name,
            payload: p.type,
          });
        }

        props.push(p);
      }
    }
  } catch {
    // ignore
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
    styleTokens: extractStyleTokens(content),
  };
}

/**
 * Extracts Astro component contract from .astro source code.
 */
