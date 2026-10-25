import { basename, extname } from 'node:path';
import ts from 'typescript';
import { parseAstro, parseAstroAttributes } from '../astro-sfc';
import type {
  AstroIslandContract,
  ComponentContract,
  ComponentPropContract,
  SourceLocation,
} from '../../types';
import { getSourcePosition } from '../source-file';

function inferTypeFromLiteral(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isNumericLiteral(node)) return 'number';
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  if (ts.isArrayLiteralExpression(node)) return 'any[]';
  if (ts.isObjectLiteralExpression(node)) return 'Record<string, any>';
  return 'any';
}

export async function extractAstroContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const descriptor = parseAstro(content, filePath);
  const propsMap = new Map<string, ComponentPropContract>();
  const slots: string[] = [];
  const islands: AstroIslandContract[] = [];

  // 1. Parse frontmatter TypeScript AST
  if (descriptor.frontmatter) {
    const fmContent = descriptor.frontmatter.content;
    const sf = ts.createSourceFile('frontmatter.ts', fmContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // Collect interface and type alias declarations for Props
    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt) && /Props$/i.test(stmt.name.text)) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const name = member.name.getText(sf).trim();
            const required = !member.questionToken;
            const type = member.type ? member.type.getText(sf).trim() : 'any';
            propsMap.set(name, { name, type, required });
          }
        }
      } else if (ts.isTypeAliasDeclaration(stmt) && /Props$/i.test(stmt.name.text)) {
        if (ts.isTypeLiteralNode(stmt.type)) {
          for (const member of stmt.type.members) {
            if (ts.isPropertySignature(member) && member.name) {
              const name = member.name.getText(sf).trim();
              const required = !member.questionToken;
              const type = member.type ? member.type.getText(sf).trim() : 'any';
              propsMap.set(name, { name, type, required });
            }
          }
        } else if (ts.isIntersectionTypeNode(stmt.type)) {
          for (const typeElem of stmt.type.types) {
            if (ts.isTypeLiteralNode(typeElem)) {
              for (const member of typeElem.members) {
                if (ts.isPropertySignature(member) && member.name) {
                  const name = member.name.getText(sf).trim();
                  const required = !member.questionToken;
                  const type = member.type ? member.type.getText(sf).trim() : 'any';
                  propsMap.set(name, { name, type, required });
                }
              }
            }
          }
        }
      }
    }

    // Inspect statements for destructuring `Astro.props`
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        let initExpr = node.initializer;
        while (ts.isAsExpression(initExpr) || ts.isTypeAssertionExpression(initExpr) || ts.isParenthesizedExpression(initExpr)) {
          initExpr = initExpr.expression;
        }

        const isAstroProps = ts.isPropertyAccessExpression(initExpr) &&
          ts.isIdentifier(initExpr.expression) && initExpr.expression.text === 'Astro' &&
          initExpr.name.text === 'props';

        if (isAstroProps && ts.isObjectBindingPattern(node.name)) {
          for (const elem of node.name.elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
              const propName = (elem.propertyName && ts.isIdentifier(elem.propertyName))
                ? elem.propertyName.text
                : elem.name.text;
              const defaultValue = elem.initializer ? elem.initializer.getText(sf).trim() : undefined;

              if (propsMap.has(propName)) {
                const existing = propsMap.get(propName)!;
                if (defaultValue !== undefined) {
                  existing.default = defaultValue;
                  existing.required = false;
                }
              } else {
                propsMap.set(propName, {
                  name: propName,
                  type: elem.initializer ? inferTypeFromLiteral(elem.initializer) : 'any',
                  required: defaultValue === undefined,
                  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 2. Parse template for slots and islands
  if (descriptor.template) {
    const tmplText = descriptor.template.content;
    const tmplOffset = descriptor.template.loc.start.offset;

    // Slots: <slot /> or <slot name="header" />
    const slotRegex = /<slot\b([^>]*)(\/?>)/g;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotRegex.exec(tmplText)) !== null) {
      const attrString = slotMatch[1];
      const nameMatch = attrString.match(/\bname=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+))/);
      const slotName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? nameMatch[4]) : 'default';
      if (!slots.includes(slotName)) {
        slots.push(slotName);
      }
    }

    // Islands: <Comp ... client:... /> or <Comp ... client:...>...</Comp>
    const islandRegex = /<([A-Z][A-Za-z0-9_.]*)\b([^>]*\bclient:(?:load|visible|idle|media|only)[^>]*)(\/?>|>)/g;
    let islandMatch: RegExpExecArray | null;
    while ((islandMatch = islandRegex.exec(tmplText)) !== null) {
      const compName = islandMatch[1];
      const attrString = islandMatch[2];
      const startOffset = tmplOffset + islandMatch.index;
      const endOffset = startOffset + islandMatch[0].length;

      const directiveMatch = attrString.match(/\b(client:(?:load|visible|idle|media|only))(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/);
      const directiveName = directiveMatch ? directiveMatch[1] : 'client:load';
      const directiveVal = directiveMatch ? (directiveMatch[2] ?? directiveMatch[3] ?? directiveMatch[4] ?? directiveMatch[5]) : undefined;

      const attrs = parseAstroAttributes(attrString);
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (!k.startsWith('client:')) {
          props[k] = v === true ? 'true' : String(v);
        }
      }

      const loc: SourceLocation = {
        start: { ...getSourcePosition(content, startOffset), offset: startOffset },
        end: { ...getSourcePosition(content, endOffset), offset: endOffset },
      };

      islands.push({
        component: compName,
        directive: directiveName,
        ...(directiveVal !== undefined ? { directiveValue: directiveVal } : {}),
        ...(Object.keys(props).length > 0 ? { props } : {}),
        loc,
      });
    }
  }

  return {
    component,
    framework: 'astro',
    filePath,
    props: Array.from(propsMap.values()),
    emits: [],
    slots,
    islands: islands.length > 0 ? islands : undefined,
  };
}
