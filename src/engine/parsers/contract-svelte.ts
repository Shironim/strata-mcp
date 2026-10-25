import { basename, extname } from 'node:path';
import ts from 'typescript';
import { parseSvelte } from '../svelte-sfc';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ComponentSlotDetail,
} from '../../types';

function inferTypeFromLiteral(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isNumericLiteral(node)) return 'number';
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  if (ts.isArrayLiteralExpression(node)) return 'any[]';
  if (ts.isObjectLiteralExpression(node)) return 'Record<string, any>';
  return 'any';
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isParenthesizedExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression;
  }
  return curr;
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

  const typeDefs = new Map<string, { type: string; required: boolean; default?: string }>();

  // Process scripts (module & instance)
  const scriptsToParse: Array<{ content: string; isInstance: boolean }> = [];
  if (descriptor.module) scriptsToParse.push({ content: descriptor.module.content, isInstance: false });
  if (descriptor.instance) scriptsToParse.push({ content: descriptor.instance.content, isInstance: true });

  for (const { content: scriptContent, isInstance } of scriptsToParse) {
    const sf = ts.createSourceFile('svelte-script.ts', scriptContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // 1. Collect Type Definitions (Interfaces & Type Aliases)
    const collectMembers = (members: ts.NodeArray<ts.TypeElement>) => {
      for (const member of members) {
        if (ts.isPropertySignature(member) && member.name) {
          const name = member.name.getText(sf).trim();
          const required = !member.questionToken;
          const type = member.type ? member.type.getText(sf).trim() : 'any';
          typeDefs.set(name, { type, required });
        }
      }
    };

    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        collectMembers(stmt.members);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        if (ts.isTypeLiteralNode(stmt.type)) {
          collectMembers(stmt.type.members);
        } else if (ts.isIntersectionTypeNode(stmt.type)) {
          for (const elem of stmt.type.types) {
            if (ts.isTypeLiteralNode(elem)) {
              collectMembers(elem.members);
            }
          }
        }
      }

      // Check exposed functions in instance script: export function foo() / export const bar = () =>
      if (isInstance) {
        const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
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
      if (ts.isVariableDeclaration(node) && node.initializer && isPropsCall(node.initializer)) {
        // Collect inline type annotations if present
        const inlineTypes = new Map<string, { type: string; required: boolean }>();
        if (node.type && ts.isTypeLiteralNode(node.type)) {
          for (const member of node.type.members) {
            if (ts.isPropertySignature(member) && member.name) {
              const name = member.name.getText(sf).trim();
              const required = !member.questionToken;
              const type = member.type ? member.type.getText(sf).trim() : 'any';
              inlineTypes.set(name, { type, required });
            }
          }
        }

        if (ts.isObjectBindingPattern(node.name)) {
          for (const elem of node.name.elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
              const propName = (elem.propertyName && ts.isIdentifier(elem.propertyName))
                ? elem.propertyName.text
                : elem.name.text;

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

              if (inlineTypes.has(propName)) {
                const info = inlineTypes.get(propName)!;
                type = info.type;
                required = defaultValue === undefined && info.required;
              } else if (typeDefs.has(propName)) {
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

    // Svelte 5 Snippets as Slots (e.g. Snippet, Snippet<...>, children)
    if (prop.name === 'children') {
      if (!slots.includes('default')) slots.push('default');
      slotDetails.push({ name: 'default', description: 'Children snippet or default slot' });
    } else if (prop.type.includes('Snippet') || prop.name === 'header' || prop.name === 'footer') {
      if (!slots.includes(prop.name)) slots.push(prop.name);
      slotDetails.push({ name: prop.name, description: `${prop.name} snippet` });
    }
  }

  // 5. Template slot and snippet scanning
  const rawTemplate = descriptor.template?.content || content;

  // Svelte 4 <slot /> and <slot name="..." />
  const slotRegex = /<slot\b([^>]*)\/?>/gi;
  let slotMatch: RegExpExecArray | null;
  while ((slotMatch = slotRegex.exec(rawTemplate)) !== null) {
    const attrs = slotMatch[1];
    const nameMatch = attrs.match(/\bname=["']([^"']+)["']/i);
    const slotName = nameMatch ? nameMatch[1] : 'default';
    if (!slots.includes(slotName)) {
      slots.push(slotName);
      slotDetails.push({ name: slotName });
    }
  }

  // Svelte 5 {#snippet name(...)}
  const snippetRegex = /\{#snippet\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\}/g;
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(rawTemplate)) !== null) {
    const snippetName = snippetMatch[1];
    if (!slots.includes(snippetName)) {
      slots.push(snippetName);
      slotDetails.push({ name: snippetName, description: 'Template defined snippet' });
    }
  }

  return {
    component,
    framework: 'svelte',
    filePath,
    props: Array.from(propsMap.values()),
    emits,
    slots,
    slotDetails: slotDetails.length > 0 ? slotDetails : undefined,
    models: models.length > 0 ? models : undefined,
    exposed: exposed.length > 0 ? exposed : undefined,
  };
}

