import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import ts from 'typescript';
import { parseTypeScript } from '../source-parser';
import { getCandidateNames, isComponentNameMatch, isVueTagBoundLocally, toKebabCase } from '../template';
import { escapeRegExp } from '../patterns';
import { walkVueDom, extractVueTemplate } from './ast-helpers';

export interface DynamicComponentWarning {
  component: string;
  warning: string;
}

/**
 * Extracts custom component tags rendered in a template or JSX (e.g. <AppHeader>, <app-button>).
 * Also resolves dynamic components rendered via Vue/Nuxt `<component :is="...">` and dictionary maps.
 */
/**
 * Helper to resolve component references from an object literal dictionary in TypeScript AST.
 */
export function extractDictionaryComponentsFromTsAst(sourceFile: ts.SourceFile, dictVarName: string, tags: Set<string>): void {
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === dictVarName) {
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
            const compName = prop.initializer.text;
            if (/^[A-Z][A-Za-z0-9_$]*$/.test(compName)) {
              tags.add(compName);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/**
 * Builds an index of available component files in the project for auto-import resolution.
 * Maps lowercase component names (both PascalCase and kebab-case) to their absolute file paths.
 */
/**
 * Extracts custom component tags rendered in a template or JSX (e.g. <AppHeader>, <app-button>).
 */
function resolveDynamicComponentTag(
  prop: any,
  getTsSourceFile: () => ts.SourceFile,
  tags: Set<string>
): void {
  if (
    prop.type !== NodeTypes.DIRECTIVE ||
    prop.name !== 'bind' ||
    !prop.arg ||
    !('content' in prop.arg) ||
    prop.arg.content !== 'is' ||
    !prop.exp ||
    !('content' in prop.exp)
  ) {
    return;
  }

  const exp = prop.exp.content.trim();
  const directMatch = exp.match(/^([A-Z][A-Za-z0-9_$]*)$/);
  if (directMatch) {
    tags.add(directMatch[1]);
    return;
  }

  const mapMatch = exp.match(/^([A-Za-z0-9_$]+)(?:\[|\.)/);
  if (mapMatch) {
    extractDictionaryComponentsFromTsAst(getTsSourceFile(), mapMatch[1], tags);
  }
}

const HTML_COMMENT_RE = new RegExp('<' + '!--[\\s\\S]*?-->', 'g');
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const DOUBLE_QUOTE_RE = /"[^"\\]*(?:\\.[^"\\]*)*"/g;
const SINGLE_QUOTE_RE = /'[^'\\]*(?:\\.[^'\\]*)*'/g;

function sanitizeTemplateContent(raw: string): string {
  return raw
    .replace(HTML_COMMENT_RE, '')
    .replace(BLOCK_COMMENT_RE, '')
    .replace(LINE_COMMENT_RE, '')
    .replace(DOUBLE_QUOTE_RE, '')
    .replace(SINGLE_QUOTE_RE, '');
}

/**
 * Traverses Vue/Nuxt SFC template AST, TSX JSX elements, and Astro component templates
 * to extract supported rendered child component tags as static candidates.
 * Also resolves dynamic components rendered via Vue/Nuxt `<component :is="...">` and dictionary maps
 * using official AST traversals (@vue/compiler-dom and TypeScript Compiler API).
 */
export function extractRenderedCustomTags(content: string): string[] {
  const tags = new Set<string>();

  // 1. Vue/Nuxt AST traversal via @vue/compiler-dom
  const vueTemplate = extractVueTemplate(content);
  const templateSource = vueTemplate ?? (/<[A-Za-z]/.test(content) && !content.includes('export default') ? content : null);

  let sourceFile: ts.SourceFile | null = null;
  const getTsSourceFile = () => {
    if (!sourceFile) {
      let scriptCode = content;
      if (content.includes('<script')) {
        const scriptMatches = Array.from(content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
        if (scriptMatches.length > 0) {
          scriptCode = scriptMatches.map((m) => m[1]).join('\n');
        }
      }
      sourceFile = parseTypeScript('component.tsx', scriptCode, ts.ScriptKind.TSX);
    }
    return sourceFile;
  };

  if (templateSource) {
    try {
      const ast = parseDom(templateSource, { comments: false });
      walkVueDom(ast, (el, bindings) => {
        if (isVueTagBoundLocally(el.tag, bindings)) return;
        if (el.tag === 'component') {
          for (const prop of el.props) {
            resolveDynamicComponentTag(prop, getTsSourceFile, tags);
          }
          return;
        }

        if (
          /^[A-Z][A-Za-z0-9_.]*$/.test(el.tag) ||
          /^[a-z][a-z0-9_]*-[a-z0-9_.-]*$/.test(el.tag)
        ) {
          tags.add(el.tag);
        }
      });
    } catch {
      // Fall through to JS/TS AST and fallback regex if template parsing errors
    }
  }

  // 2. React / JSX / Astro AST traversal via TypeScript AST
  try {
    const sf = getTsSourceFile();
    function visit(node: ts.Node) {
      // JSX opening & self-closing elements: <ProductCard ... />
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName)) {
          const name = node.tagName.text;
          if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) {
            tags.add(name);
          }
        } else if (ts.isPropertyAccessExpression(node.tagName)) {
          const fullName = node.tagName.getText(sf);
          if (/^[A-Z]/.test(fullName)) {
            tags.add(fullName);
          }
        }
      }

      // React dynamic component assignment: const SelectedWidget = WIDGETS[type];
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z][A-Za-z0-9_$]*$/.test(node.name.text)) {
        if (node.initializer && ts.isElementAccessExpression(node.initializer)) {
          if (ts.isIdentifier(node.initializer.expression)) {
            const mapVarName = node.initializer.expression.text;
            extractDictionaryComponentsFromTsAst(sf, mapVarName, tags);
          }
        }
      }

      // React.createElement or jsx/jsxs call: createElement(DynamicModal, ...)
      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(sf);
        if (
          calleeText === 'createElement' ||
          calleeText === 'React.createElement' ||
          calleeText === 'jsx' ||
          calleeText === 'jsxs' ||
          calleeText.endsWith('.createElement')
        ) {
          if (node.arguments.length > 0 && ts.isIdentifier(node.arguments[0])) {
            const compName = node.arguments[0].text;
            if (/^[A-Z][A-Za-z0-9_$]*$/.test(compName)) {
              tags.add(compName);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(sf);
  } catch {
    // Fallback if AST generation fails
  }

  // 3. Resilient fallback for standalone raw fragments (only if no SFC template is present)
  if (vueTemplate === null) {
    const sanitized = sanitizeTemplateContent(content);
    const tagRegex = /<([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9_]*-[a-z0-9_-]*)/g;
    for (const match of sanitized.matchAll(tagRegex)) {
      tags.add(match[1]);
    }
  }

  return Array.from(tags);
}

/**
 * Extracts warnings for dynamic or polymorphic components that cannot be statically resolved.
 */
export function extractDynamicWarnings(
  content: string,
  resolvedCustomTags: Set<string>
): DynamicComponentWarning[] {
  const warnings: DynamicComponentWarning[] = [];

  // 1. Vue dynamic component: <component :is="expr" /> where expr is not resolved statically
  const anyIsRegex = /<component\s+[^>]*?(?::|v-bind:)is=["']([^"']+)["']/g;
  for (const m of content.matchAll(anyIsRegex)) {
    const rawExpr = m[1].trim();
    if (!resolvedCustomTags.has(rawExpr)) {
      warnings.push({
        component: `<component :is="${rawExpr}">`,
        warning: `Dynamic/polymorphic component (:is="${rawExpr}") cannot be statically resolved`,
      });
    }
  }

  // 2. Radix UI / Headless / Polymorphic asChild pattern
  const asChildRegex = /<([A-Z][A-Za-z0-9_.]*)\s+[^>]*?\basChild\b/g;
  for (const m of content.matchAll(asChildRegex)) {
    warnings.push({
      component: `<${m[1]} asChild>`,
      warning: `Polymorphic delegate component (<${m[1]} asChild>) cannot be statically resolved`,
    });
  }

  return warnings;
}

/**
 * Checks if a single candidate name appears as a rendered tag, `:is` binding, or inside a dynamic map
 * by querying AST-extracted tags from extractRenderedCustomTags.
 */
export function isCandidateRendered(content: string, candidate: string): boolean {
  const renderedTags = extractRenderedCustomTags(content);
  for (const tag of renderedTags) {
    if (isComponentNameMatch(tag, candidate)) return true;
    // Support namespaced and dot-access components: <COMPONENT_MAP.candidate /> or <UI.Button />
    const lastPart = tag.split('.').pop();
    if (lastPart && isComponentNameMatch(lastPart, candidate)) return true;
  }

  // If Vue template was present, AST traversal via @vue/compiler-dom is authoritative
  const vueTemplate = extractVueTemplate(content);
  if (vueTemplate !== null) {
    return false;
  }

  // Resilient fallback for non-SFC / raw template fragments, but strip comments and strings first
  const sanitized = sanitizeTemplateContent(content);

  const fastTagPattern = new RegExp(
    `<(?:[A-Za-z0-9_$.]+\\.)?${escapeRegExp(candidate)}[\\s/>]|:is=['"]${escapeRegExp(candidate)}['"]`,
    'i'
  );
  return fastTagPattern.test(sanitized);
}

/** Normalize once per file for workspace audits; namespaced renders also expose their final name. */
export function renderedComponentKeys(content: string): Set<string> {
  const tags = extractRenderedCustomTags(content);
  if (extractVueTemplate(content) === null) {
    for (const match of sanitizeTemplateContent(content).matchAll(/<([A-Za-z0-9_$.]+)(?=[\s/>])/g)) tags.push(match[1]);
  }
  return new Set(tags.flatMap(componentTagKeys));
}

export function componentTagKeys(tag: string): string[] {
  const last = tag.split('.').pop()!;
  return [`case:${tag.toLowerCase()}`, `kebab:${toKebabCase(tag)}`, `case:${last.toLowerCase()}`, `kebab:${toKebabCase(last)}`];
}

/**
 * Checks if a component identifier or candidate alias is actually rendered in the file's template/JSX.
 */
export function isRenderedInContent(content: string, identifier: string): boolean {
  return getCandidateNames(identifier).some((candidate) => isCandidateRendered(content, candidate));
}
