import { parseTypeScript } from '../source-parser';
import { basename, extname } from 'node:path';
import ts from 'typescript';
import { unwrapExpression, staticPropertyName } from './ts-syntax';
import { resolveLocalPropType } from './local-prop-types';
import { parseAstro, parseAstroAttributes } from '../astro-sfc';
import { astroOpeningTags } from '../astro-template';
import type {
  AstroIslandContract,
  ComponentContract,
  ComponentPropContract,
  SourceLocation,
  UnresolvedTypeInfo,
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
  const unresolvedTypes: UnresolvedTypeInfo[] = [];

  // 1. Parse frontmatter TypeScript AST
  if (descriptor.frontmatter) {
    const fmContent = descriptor.frontmatter.content;
    const sf = parseTypeScript('frontmatter.ts', fmContent, ts.ScriptKind.TS);

    const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
    for (const statement of sf.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) declaredTypes.set(statement.name.text, statement);
    }
    const propsDeclaration = declaredTypes.get('Props');
    if (propsDeclaration) resolveLocalPropType(propsDeclaration, sf, declaredTypes, new Map(), propsMap, unresolvedTypes);

    // Inspect statements for destructuring `Astro.props`
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initExpr = unwrapExpression(node.initializer);

        const isAstroProps = ts.isPropertyAccessExpression(initExpr) &&
          ts.isIdentifier(initExpr.expression) && initExpr.expression.text === 'Astro' &&
          initExpr.name.text === 'props';

        if (isAstroProps && ts.isObjectBindingPattern(node.name)) {
          for (const elem of node.name.elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name) && !elem.dotDotDotToken) {
              const propName = elem.propertyName ? staticPropertyName(elem.propertyName) : elem.name.text;
              if (propName === undefined) continue;
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

    };
    for (const statement of sf.statements) if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) visit(declaration);
    }
  }

  // 2. Parse template for slots and islands
  if (descriptor.template) {
    const tmplText = descriptor.template.content;
    const tmplOffset = descriptor.template.loc.start.offset;

    // Slots: <slot /> or <slot name="header" />
    const tags = astroOpeningTags(tmplText);
    for (const tag of tags.filter(tag => tag.name === 'slot')) {
      const attrString = tag.attributes;
      const nameMatch = attrString.match(/\bname=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+))/);
      const slotName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? nameMatch[4]) : 'default';
      if (!slots.includes(slotName)) {
        slots.push(slotName);
      }
    }

    // Islands: <Comp ... client:... /> or <Comp ... client:...>...</Comp>
    for (const tag of tags.filter(tag => /^[A-Z]/.test(tag.name))) {
      const compName = tag.name;
      const attrString = tag.attributes;
      const attrs = parseAstroAttributes(attrString);
      const directiveName = Object.keys(attrs).find(name => /^client:(load|visible|idle|media|only)$/.test(name));
      if (!directiveName) continue;
      const directiveVal = attrs[directiveName] === true ? undefined : String(attrs[directiveName]);
      const startOffset = tmplOffset + tag.start;
      const endOffset = tmplOffset + tag.end;
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
    ...(unresolvedTypes.length ? { unresolvedTypes } : {}),
    emits: [],
    slots,
    islands: islands.length > 0 ? islands : undefined,
  };
}
