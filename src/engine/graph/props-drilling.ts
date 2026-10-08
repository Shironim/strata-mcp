import { parse as parseDom, NodeTypes } from "@vue/compiler-dom";
import ts from "typescript";
import { isComponentNameMatch } from "../template";
import { escapeRegExp } from "../patterns";
import type {
  ComponentTreeNode,
  PassedPropInfo,
  PropsDrillingAlert,
} from "../../types";
import { walkVueDom, extractVueTemplate } from "./ast-helpers";

export interface PropTracker {
  propName: string;
  expression: string;
  originComponent: string;
  drilledThrough: string[];
}

/**
 * Extracts props and dynamic bindings passed to child components in a template or JSX.
 */
function extractVueElementProp(prop: any, seenProps: Set<string>, passedProps: PassedPropInfo[]): void {
  // Static attributes (e.g. data-testid="user-card", title="Hello", active)
  if (prop.type === NodeTypes.ATTRIBUTE) {
    const propName = prop.name;
    if (
      propName.startsWith(':') ||
      propName.startsWith('v-') ||
      propName.startsWith('@') ||
      ['class', 'style', 'id', 'ref', 'key'].includes(propName)
    ) {
      return;
    }
    if (!seenProps.has(propName)) {
      seenProps.add(propName);
      const expression = prop.value ? JSON.stringify(prop.value.content) : '"true"';
      passedProps.push({ propName, expression });
    }
    return;
  }

  // Dynamic directives (:prop="expr", v-bind:prop="expr", v-bind="expr", v-model="expr")
  if (prop.type === NodeTypes.DIRECTIVE) {
    if (prop.name === 'bind') {
      if (prop.arg && 'content' in prop.arg) {
        const propName = prop.arg.content;
        const expression = prop.exp && 'content' in prop.exp ? prop.exp.content.trim() : '';
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          passedProps.push({ propName, expression });
        }
      } else if (!prop.arg && prop.exp && 'content' in prop.exp) {
        const propName = '...v-bind';
        const expression = prop.exp.content.trim();
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          passedProps.push({ propName, expression });
        }
      }
    } else if (prop.name === 'model') {
      const propName = prop.arg && 'content' in prop.arg ? `v-model:${prop.arg.content}` : 'v-model';
      const expression = prop.exp && 'content' in prop.exp ? prop.exp.content.trim() : '';
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression });
      }
    }
  }
}

function extractVueTemplatePassedProps(
  parentContent: string,
  componentNames: string[],
  seenProps: Set<string>,
  passedProps: PassedPropInfo[]
): void {
  const vueTemplate = extractVueTemplate(parentContent);
  const templateSource = vueTemplate ?? (/<[A-Za-z]/.test(parentContent) && !parentContent.includes('export default') ? parentContent : null);
  if (!templateSource) return;

  try {
    const ast = parseDom(templateSource, { comments: false });
    walkVueDom(ast, (el) => {
      const isMatched = componentNames.some((c) => isComponentNameMatch(el.tag, c));
      if (!isMatched) return;

      for (const prop of el.props) {
        extractVueElementProp(prop, seenProps, passedProps);
      }
    });
  } catch {
    // Fall through to JSX AST and fallback regex if template parsing fails
  }
}

function extractJsxAttributeProp(
  attr: ts.JsxAttributeLike,
  sourceFile: ts.SourceFile,
  seenProps: Set<string>,
  passedProps: PassedPropInfo[]
): void {
  if (ts.isJsxAttribute(attr)) {
    const propName = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText(sourceFile);
    if (['class', 'className', 'style', 'id', 'ref', 'key'].includes(propName)) {
      return;
    }
    let expression = '"true"';
    if (attr.initializer) {
      if (ts.isStringLiteral(attr.initializer)) {
        expression = JSON.stringify(attr.initializer.text);
      } else if (ts.isJsxExpression(attr.initializer)) {
        expression = attr.initializer.expression
          ? attr.initializer.expression.getText(sourceFile).trim()
          : 'true';
      } else {
        expression = attr.initializer.getText(sourceFile).trim();
      }
    }
    if (!seenProps.has(propName)) {
      seenProps.add(propName);
      passedProps.push({ propName, expression });
    }
  } else if (ts.isJsxSpreadAttribute(attr)) {
    const propName = '...spread';
    const expression = attr.expression.getText(sourceFile).trim();
    if (!seenProps.has(propName)) {
      seenProps.add(propName);
      passedProps.push({ propName, expression });
    }
  }
}

function extractJsxPassedProps(
  parentContent: string,
  componentNames: string[],
  seenProps: Set<string>,
  passedProps: PassedPropInfo[]
): void {
  try {
    const sourceFile = ts.createSourceFile('component.tsx', parentContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        let tagName = '';
        if (ts.isIdentifier(node.tagName)) {
          tagName = node.tagName.text;
        } else if (ts.isPropertyAccessExpression(node.tagName)) {
          tagName = node.tagName.getText(sourceFile);
        }

        if (tagName && componentNames.some((c) => isComponentNameMatch(tagName, c))) {
          for (const attr of node.attributes.properties) {
            extractJsxAttributeProp(attr, sourceFile, seenProps, passedProps);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  } catch {
    // Fallback if AST generation fails
  }
}

function extractRegexFallbackPassedProps(
  parentContent: string,
  componentNames: string[],
  seenProps: Set<string>,
  passedProps: PassedPropInfo[]
): void {
  for (const name of componentNames) {
    const tagRegex = new RegExp(`<${escapeRegExp(name)}([\\s\\S]*?)(?:\\/?>|>)`, 'i');
    const match = parentContent.match(tagRegex);
    if (!match) continue;

    const attributesBlock = match[1];

    // Dynamic bindings: :propName="expression" or v-bind:propName="expression"
    const dynamicBindingRegex = /(?::|v-bind:)([A-Za-z0-9_-]+)=["']([^"']+)["']/g;
    for (const b of attributesBlock.matchAll(dynamicBindingRegex)) {
      const propName = b[1];
      const expression = b[2].trim();
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression });
      }
    }

    // Two-way bindings: v-model="expression" or v-model:propName="expression"
    const vModelRegex = /v-model(?::([A-Za-z0-9_-]+))?=["']([^"']+)["']/g;
    for (const b of attributesBlock.matchAll(vModelRegex)) {
      const propName = b[1] ? `v-model:${b[1]}` : 'v-model';
      const expression = b[2].trim();
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression });
      }
    }

    // Static string attributes
    const staticPropRegex = /\b([A-Za-z0-9_-]+)=["']([^"']+)["']/g;
    for (const s of attributesBlock.matchAll(staticPropRegex)) {
      const propName = s[1];
      if (
        propName.startsWith(':') ||
        propName.startsWith('v-') ||
        propName.startsWith('@') ||
        ['class', 'style', 'id', 'ref', 'key'].includes(propName)
      ) {
        continue;
      }
      if (!seenProps.has(propName)) {
        seenProps.add(propName);
        passedProps.push({ propName, expression: `"${s[2]}"` });
      }
    }
  }
}

/**
 * Extracts props and dynamic bindings passed to child components in a template or JSX
 * using official AST traversals (@vue/compiler-dom for Vue templates and TypeScript Compiler API for JSX).
 */
export function extractPassedProps(parentContent: string, componentNames: string[]): PassedPropInfo[] {
  const passedProps: PassedPropInfo[] = [];
  const seenProps = new Set<string>();

  extractVueTemplatePassedProps(parentContent, componentNames, seenProps, passedProps);
  extractJsxPassedProps(parentContent, componentNames, seenProps, passedProps);

  if (passedProps.length === 0) {
    extractRegexFallbackPassedProps(parentContent, componentNames, seenProps, passedProps);
  }

  return passedProps;
}

/**
 * Standard alias for extractPassedProps as specified in Phase 3 AST Native Parser Migration RFC.
 */
export const extractRenderedPassedProps = extractPassedProps;

/**
 * Traverses the resolved component tree to identify props forwarded through
 * 1 or more intermediate components without local consumption or transformation.
 */
export function detectPropsDrilling(root: ComponentTreeNode): PropsDrillingAlert[] {
  const alerts: PropsDrillingAlert[] = [];
  const seen = new Set<string>();

  function traverse(node: ComponentTreeNode, activeChains: PropTracker[]) {
    for (const child of node.children) {
      const nextChains: PropTracker[] = [];

      if (child.passedProps && child.passedProps.length > 0) {
        for (const p of child.passedProps) {
          const propName = p.propName;
          const expr = (p.expression || '').trim();

          // Check if this prop matches or forwards an active prop chain received by `node`
          const matchedChain = activeChains.find((c) => {
            if (c.propName === expr) return true;
            if (expr === `props.${c.propName}`) return true;
            if (c.expression && c.expression === expr) return true;
            if (expr.startsWith(`${c.propName}.`) || expr.startsWith(`${c.propName}[`)) return true;
            if (expr.startsWith(`props.${c.propName}.`) || expr.startsWith(`props.${c.propName}[`)) return true;
            if (c.expression && (expr.startsWith(`${c.expression}.`) || expr.startsWith(`${c.expression}[`))) return true;
            return false;
          });

          if (matchedChain) {
            const drilledThrough = [...matchedChain.drilledThrough, node.component];
            const depth = drilledThrough.length + 1;

            if (depth >= 2) {
              const alertKey = `${matchedChain.originComponent}:${drilledThrough.join('>')}:${child.component}:${propName}`;
              if (!seen.has(alertKey)) {
                seen.add(alertKey);
                alerts.push({
                  prop: p.expression || propName,
                  origin: matchedChain.originComponent,
                  drilledThrough,
                  target: child.component,
                  depth,
                  recommendation:
                    depth >= 3
                      ? `Consider Pinia/Zustand or Provide/Inject to eliminate deep ${depth}-level props drilling`
                      : `Provide/Inject or Composable candidate instead of drilling through ${node.component}`,
                });
              }
            }

            nextChains.push({
              propName,
              expression: expr || matchedChain.expression,
              originComponent: matchedChain.originComponent,
              drilledThrough,
            });
          } else {
            // New prop chain originating from `node`
            nextChains.push({
              propName,
              expression: expr,
              originComponent: node.component,
              drilledThrough: [],
            });
          }
        }
      }

      traverse(child, nextChains);
    }
  }

  traverse(root, []);
  return alerts;
}
