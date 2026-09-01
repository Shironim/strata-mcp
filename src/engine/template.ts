import {
  parse as parseDom,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
  type ElementNode,
  type ExpressionNode,
} from '@vue/compiler-dom';
import type { RawMatch, ResolvedMatch, SfcBlock } from '../types';
import { remapMatches } from './remapper';
import { stripQuotes } from './patterns';

/**
 * Converts PascalCase to kebab-case (e.g., OldButton -> old-button).
 */
export function toKebabCase(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Converts kebab-case or snake_case to PascalCase (e.g., old-button -> OldButton).
 */
export function toPascalCase(str: string): string {
  return str
    .replace(/(?:^|[-_])([a-z0-9])/gi, (_, char) => char.toUpperCase())
    .replace(/[-_]/g, '');
}

/**
 * Returns all common naming variations for a component name (PascalCase and kebab-case).
 */
export function getCandidateNames(name: string): string[] {
  const names = new Set<string>();
  names.add(name);
  names.add(toPascalCase(name));
  names.add(toKebabCase(name));
  return Array.from(names).filter(Boolean);
}

/**
 * Checks if two component tag names match in either PascalCase or kebab-case.
 */
export function isComponentNameMatch(tag: string, targetName: string): boolean {
  if (tag === targetName) return true;
  return toKebabCase(tag) === toKebabCase(targetName);
}

export interface TemplateSearchOptions {
  componentName?: string;
  tag?: string;
  attribute?: string;
  directive?: string;
}

/**
 * Traverses Vue Compiler-DOM AST and finds matching element/component occurrences.
 */
export function searchTemplateAst(templateContent: string, options: TemplateSearchOptions): RawMatch[] {
  let root: RootNode;
  try {
    root = parseDom(templateContent);
  } catch {
    return [];
  }

  const matches: RawMatch[] = [];

  function traverse(nodes: TemplateChildNode[]) {
    for (const node of nodes) {
      if (node.type === NodeTypes.ELEMENT) {
        const el = node as ElementNode;
        let isMatched = false;

        // 1. Match by component name (PascalCase, kebab-case, or namespace like UI.OldButton)
        if (options.componentName) {
          const tagPart = el.tag.includes('.') ? el.tag.split('.').pop()! : el.tag;

          if (isComponentNameMatch(tagPart, options.componentName)) {
            isMatched = true;
          } else if (el.tag === 'component') {
            // Check dynamic <component :is="OldButton"> or <component is="OldButton">
            for (const prop of el.props) {
              if (
                prop.type === NodeTypes.ATTRIBUTE &&
                prop.name === 'is' &&
                prop.value &&
                isComponentNameMatch(prop.value.content, options.componentName)
              ) {
                isMatched = true;
                break;
              }
              if (
                prop.type === NodeTypes.DIRECTIVE &&
                prop.name === 'bind' &&
                prop.arg &&
                'content' in prop.arg &&
                prop.arg.content === 'is' &&
                prop.exp &&
                'content' in prop.exp &&
                (prop.exp.content === options.componentName ||
                  prop.exp.content === `'${options.componentName}'` ||
                  prop.exp.content === `"${options.componentName}"` ||
                  isComponentNameMatch(stripQuotes(prop.exp.content), options.componentName))
              ) {
                isMatched = true;
                break;
              }
            }
          }
        }

        // 2. Match by exact tag
        if (options.tag && el.tag === options.tag) {
          isMatched = true;
        }

        // 3. Match by attribute name
        if (options.attribute) {
          for (const prop of el.props) {
            if (prop.type === NodeTypes.ATTRIBUTE && prop.name === options.attribute) {
              isMatched = true;
              break;
            }
          }
        }

        // 4. Match by directive name (e.g., 'if', 'for', 'model')
        if (options.directive) {
          for (const prop of el.props) {
            if (prop.type === NodeTypes.DIRECTIVE && prop.name === options.directive) {
              isMatched = true;
              break;
            }
          }
        }

        if (isMatched) {
          // Detect client directives (e.g., client:load, client:visible for Astro / Islands)
          let clientDirective: string | undefined;
          for (const prop of el.props) {
            const rawProp = prop.loc.source.trim();
            if (rawProp.startsWith('client:')) {
              clientDirective = rawProp.split(/[ =]/)[0];
              break;
            }
          }

          // Get the opening tag or entire element snippet
          const snippet = el.loc.source.split('\n')[0] || el.loc.source;
          matches.push({
            line: el.loc.start.line,
            column: el.loc.start.column,
            endLine: el.loc.end.line,
            endColumn: el.loc.end.column,
            text: snippet.trim(),
            clientDirective,
          });
        }

        // Traverse children recursively
        if (el.children && el.children.length > 0) {
          traverse(el.children);
        }
      }
    }
  }

  traverse(root.children);
  return matches;
}

/**
 * Searches for component usage inside a template block and remaps matches to original file positions.
 */
export function findComponentInTemplateBlock(
  templateBlock: SfcBlock,
  componentName: string,
  filePath: string
): ResolvedMatch[] {
  const rawMatches = searchTemplateAst(templateBlock.content, { componentName });
  return remapMatches(rawMatches, templateBlock, filePath);
}

export interface TemplateExpression {
  content: string;
  start: { line: number; column: number };
}

/**
 * Extracts JS expression snippets from a Vue/Astro template:
 * directive values (`@click`, `v-if`, `:prop`, `v-model`) and interpolations (`{{ ... }}`).
 */
export function extractTemplateExpressions(templateContent: string): TemplateExpression[] {
  let root: RootNode;
  try {
    root = parseDom(templateContent);
  } catch {
    return [];
  }

  const expressions: TemplateExpression[] = [];

  function pushExpression(exp: ExpressionNode | undefined): void {
    if (!exp || !('content' in exp)) return;
    const content = exp.content.trim();
    if (!content) return;

    expressions.push({
      content,
      start: { line: exp.loc.start.line, column: exp.loc.start.column },
    });
  }

  function walk(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (prop.type === NodeTypes.DIRECTIVE && prop.exp) {
          pushExpression(prop.exp);
        }
      }
    } else if (node.type === NodeTypes.INTERPOLATION) {
      pushExpression(node.content);
    } else if (node.type === NodeTypes.IF) {
      for (const branch of node.branches) {
        if (branch.condition) pushExpression(branch.condition);
        for (const child of branch.children) walk(child);
      }
      return;
    } else if (node.type === NodeTypes.FOR) {
      if (node.source) pushExpression(node.source);
    }

    if (
      node.type === NodeTypes.ROOT ||
      node.type === NodeTypes.ELEMENT ||
      node.type === NodeTypes.FOR
    ) {
      for (const child of node.children) walk(child);
    }
  }

  walk(root);
  return expressions;
}
