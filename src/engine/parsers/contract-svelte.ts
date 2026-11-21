import { parseTypeScript } from '../source-parser';
import { basename, extname } from 'node:path';
import ts from 'typescript';
import { unwrapExpression, staticPropertyName } from './ts-syntax';
import { resolveLocalPropType } from './local-prop-types';
import { parseSvelte } from '../svelte-sfc';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ComponentSlotDetail,
  UnresolvedTypeInfo,
} from '../../types';

function inferTypeFromLiteral(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isNumericLiteral(node)) return 'number';
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  if (ts.isArrayLiteralExpression(node)) return 'any[]';
  if (ts.isObjectLiteralExpression(node)) return 'Record<string, any>';
  return 'any';
}

function isPropsCall(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr);
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (ts.isIdentifier(callee) && callee.text === '$props') {
      return true;
    }
  }
  return false;
}

interface BindableInfo {
  isBindable: boolean;
  defaultValue?: string;
}

function checkBindable(expr: ts.Expression | undefined, sf: ts.SourceFile): BindableInfo {
  if (!expr) return { isBindable: false };
  const unwrapped = unwrapExpression(expr);
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (ts.isIdentifier(callee) && callee.text === '$bindable') {
      const arg = unwrapped.arguments[0];
      return {
        isBindable: true,
        defaultValue: arg ? arg.getText(sf).trim() : undefined,
      };
    }
  }
  return { isBindable: false };
}

export async function extractSvelteContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const descriptor = parseSvelte(content, filePath);

  const propsMap = new Map<string, ComponentPropContract>();
  const models: ComponentModelContract[] = [];
  const emits: ComponentEmitContract[] = [];
  const slots: string[] = [];
  const slotDetails: ComponentSlotDetail[] = [];
  const exposed: string[] = [];

  const unresolvedTypes: UnresolvedTypeInfo[] = [];

  // Process scripts (module & instance)
  const scriptsToParse: Array<{ content: string; isInstance: boolean }> = [];
  if (descriptor.module) scriptsToParse.push({ content: descriptor.module.content, isInstance: false });
  if (descriptor.instance) scriptsToParse.push({ content: descriptor.instance.content, isInstance: true });

  for (const { content: scriptContent, isInstance } of scriptsToParse) {
    const sf = parseTypeScript('svelte-script.ts', scriptContent, ts.ScriptKind.TS);

    const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) declaredTypes.set(stmt.name.text, stmt);
    }
    if (!isInstance) continue;
    for (const stmt of sf.statements) {
      // Check exposed functions in instance script: export function foo() / export const bar = () =>
      if (isInstance) {
        const isExported = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            exposed.push(stmt.name.text);
          } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                // If it's not an export let (prop in Svelte 4)
                const isLet = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0;
                if (!isLet && (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)))) {
                  exposed.push(decl.name.text);
                }
              }
            }
          }
        }
      }
    }

    // 2. Svelte 4 legacy `export let` statements
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const isLet = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0 || (stmt.declarationList.flags & ts.NodeFlags.Const) === 0;

        if (isExported && isLet) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const name = decl.name.text;
              const type = decl.type
                ? decl.type.getText(sf).trim()
                : (decl.initializer ? inferTypeFromLiteral(decl.initializer) : 'any');
              const defaultValue = decl.initializer ? decl.initializer.getText(sf).trim() : undefined;
              const required = !decl.initializer && !type.includes('undefined');

              propsMap.set(name, {
                name,
                type,
                required,
                default: defaultValue,
              });
            }
          }
        }
      }
    }

    // 3. Svelte 5 Runes: $props() and $bindable()
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
        && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)
        && node.initializer && isPropsCall(node.initializer)) {
        const typeDefs = new Map<string, ComponentPropContract>();
        if (node.type) resolveLocalPropType(node.type, sf, declaredTypes, new Map(), typeDefs, unresolvedTypes);
        for (const [name, prop] of typeDefs) propsMap.set(name, prop);

        if (ts.isObjectBindingPattern(node.name)) {
          for (const elem of node.name.elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name) && !elem.dotDotDotToken) {
              const propName = elem.propertyName ? staticPropertyName(elem.propertyName) : elem.name.text;
              if (propName === undefined) continue;

              const bindableInfo = checkBindable(elem.initializer, sf);
              if (bindableInfo.isBindable) {
                models.push({ name: propName });
              }

              let defaultValue: string | undefined;
              if (bindableInfo.isBindable) {
                defaultValue = bindableInfo.defaultValue;
              } else if (elem.initializer) {
                defaultValue = elem.initializer.getText(sf).trim();
              }

              // Resolve type
              let type = 'any';
              let required = defaultValue === undefined;

              if (typeDefs.has(propName)) {
                const info = typeDefs.get(propName)!;
                type = info.type;
                required = defaultValue === undefined && info.required;
              } else if (elem.initializer) {
                type = inferTypeFromLiteral(elem.initializer);
              }

              propsMap.set(propName, {
                name: propName,
                type,
                required,
                default: defaultValue,
              });
            }
          }
        } else if (ts.isIdentifier(node.name)) {
          // e.g. let props: Props = $props();
          for (const [propName, info] of typeDefs.entries()) {
            propsMap.set(propName, {
              name: propName,
              type: info.type,
              required: info.required,
            });
          }
        }
      }

      // Check Svelte 4 createEventDispatcher
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'createEventDispatcher') {
          // If typed with generics: createEventDispatcher<{ save: { id: string } }>()
          if (node.typeArguments && node.typeArguments.length > 0) {
            const typeArg = node.typeArguments[0];
            if (ts.isTypeLiteralNode(typeArg)) {
              for (const member of typeArg.members) {
                if (ts.isPropertySignature(member) && member.name) {
                  const eventName = member.name.getText(sf).trim();
                  const payload = member.type ? member.type.getText(sf).trim() : undefined;
                  emits.push({ name: eventName, payload });
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  // 4. Extract Events and Slots from Props Contract
  for (const prop of propsMap.values()) {
    // Svelte 5 callback props as emits (e.g. onSave, onClick, onChange)
    if (/^on[A-Z]/.test(prop.name) || prop.type.includes('=>') && prop.name.startsWith('on')) {
      const eventName = prop.name.slice(2, 3).toLowerCase() + prop.name.slice(3);
      if (!emits.some((e) => e.name === eventName || e.name === prop.name)) {
        emits.push({
          name: prop.name,
          payload: prop.type,
        });
      }
    }

    // Snippet props are public template inputs. Local snippet declarations live in the source map.
    if (/\bSnippet\b/.test(prop.type)) {
      const name = prop.name === 'children' ? 'default' : prop.name;
      if (slots.includes(name)) continue;
      slots.push(name);
      slotDetails.push({
        name,
        isScoped: /\bSnippet\s*<\s*\[\s*[^\]\s]/.test(prop.type),
        description: prop.name === 'children' ? 'Children snippet or default slot' : `${prop.name} snippet`,
      });
    }
  }

  for (const slot of descriptor.legacySlots ?? []) {
    if (slots.includes(slot.name)) continue;
    slots.push(slot.name);
    slotDetails.push(slot);
  }

  return {
    component,
    framework: 'svelte',
    filePath,
    props: Array.from(propsMap.values()),
    ...(unresolvedTypes.length ? { unresolvedTypes } : {}),
    emits,
    slots,
    slotDetails: slotDetails.length > 0 ? slotDetails : undefined,
    models: models.length > 0 ? models : undefined,
    exposed: exposed.length > 0 ? exposed : undefined,
  };
}

