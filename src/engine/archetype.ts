import { readSourceFile } from './source-file';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import ts from 'typescript';
import { filterLayoutTokens } from './layout-extractor';
import { collectFiles } from './collector';
import type {
  ArchetypeAuditResult,
  ArchetypeDriftViolation,
  AuditArchetypeOptions,
  ComponentInstanceRef,
  PageArchetype,
  RootWrapperLayout,
  SectionKind,
  SemanticSection,
} from '../types';

const STANDARD_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small',
  'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'path', 'circle', 'rect',
  'line', 'polyline', 'polygon', 'g', 'defs', 'use', 'symbol', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr',
]);

const FRAMEWORK_BUILTIN_TAGS = new Set([
  'template',
  'slot',
  'component',
  'transition',
  'transition-group',
  'keep-alive',
  'teleport',
  'suspense',
  'client-only',
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Teleport',
  'Suspense',
  'ClientOnly',
  'Fragment',
  'StrictMode',
]);

const INTERACTIVE_RAW_PRIMITIVES = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'table',
]);

const COMPANION_COMPONENT_REGEX = /(?:Empty|NoData|ZeroState|Pagination|Paginator|Pager|Skeleton|Spinner|Loading)/i;

const PRIMITIVE_ROLE_PATTERNS: Record<string, RegExp> = {
  button: /(?:Button|Btn|Action|Cta)/i,
  input: /(?:Input|Search|TextField|Field|TextBox)/i,
  select: /(?:Select|Dropdown|Filter|Combobox|Listbox|Picker)/i,
  textarea: /(?:Textarea|Editor|RichText)/i,
  table: /(?:Table|DataGrid|DataTable|DataList|ListTable)/i,
};

/**
 * Pure helper: normalizes kebab-case custom component tags to PascalCase,
 * while keeping standard HTML tags lowercase.
 */
export function normalizeComponentName(tag: string): string {
  if (!tag) return '';
  if (STANDARD_HTML_TAGS.has(tag.toLowerCase())) {
    return tag.toLowerCase();
  }
  if (tag.includes('-')) {
    return tag
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }
  return tag;
}

/**
 * Pure helper: determines if a tag is a custom application/design-system component.
 */
export function isCustomComponentTag(tag: string): boolean {
  if (!tag || FRAMEWORK_BUILTIN_TAGS.has(tag)) return false;
  if (STANDARD_HTML_TAGS.has(tag)) return false;
  return /^[A-Z]/.test(tag) || tag.includes('-');
}

/**
 * Pure helper: 3-Tier deterministic Semantic Section Classifier.
 */
export function classifySemanticSection(
  tag: string,
  layoutTokens: string[],
  components: ComponentInstanceRef[],
  allDescendantTags: string[],
  hasLoopDirective: boolean,
  index: number,
  totalSections: number
): SectionKind {
  const lowerTag = tag.toLowerCase();

  // Tier 1: Explicit HTML5 Semantic Landmark or Wrapper Component Name
  if (lowerTag === 'header' || /(?:PageHeader|HeaderSection|HeroHeader|TitleBar)/i.test(tag)) {
    return 'page-header';
  }
  if (lowerTag === 'nav' || /(?:FilterToolbar|FilterBar|Toolbar|SearchBar|ActionToolbar)/i.test(tag)) {
    return 'filter-toolbar';
  }
  if (lowerTag === 'aside' || /(?:Sidebar|SideNav|FilterSidebar)/i.test(tag)) {
    return 'sidebar';
  }
  if (lowerTag === 'form' || /(?:FormSection|CrudForm|EditForm|CreateForm)/i.test(tag)) {
    return 'form-section';
  }
  if (lowerTag === 'footer' || /(?:ActionFooter|PageFooter|FooterBar|ModalFooter)/i.test(tag)) {
    return 'action-footer';
  }
  if (/(?:DataTable|TableSection|DataContent|ListContainer|DataGrid)/i.test(tag)) {
    return 'data-content';
  }

  // Tier 2: Bottom-Up Child Component & Element Fingerprint
  const hasTableOrList =
    allDescendantTags.includes('table') ||
    components.some((c) => c.isCustomComponent && /(?:Table|DataGrid|DataList|ListView|CardGrid)/i.test(c.name)) ||
    (hasLoopDirective && !components.some((c) => /(?:Filter|Tab|Breadcrumb)/i.test(c.name)));

  if (hasTableOrList) {
    return 'data-content';
  }

  const hasFilterOrSearch =
    components.some(
      (c) =>
        /(?:Search|Filter|SortDropdown|DateRange|Facet)/i.test(c.name) ||
        c.props.some((p) => /(?:search|filter|query|keyword)/i.test(p))
    ) ||
    allDescendantTags.includes('search');

  const formControlCount = components.filter(
    (c) =>
      ['input', 'select', 'textarea'].includes(c.tag.toLowerCase()) ||
      (c.isCustomComponent && /(?:Input|Select|Textarea|Checkbox|Radio|Switch|DatePicker|FormField)/i.test(c.name))
  ).length;

  const hasFormTag = allDescendantTags.includes('form') || components.some((c) => c.events.includes('submit'));

  if (hasFormTag && !hasFilterOrSearch) {
    return 'form-section';
  }

  if (hasFilterOrSearch) {
    return 'filter-toolbar';
  }

  if (formControlCount >= 2 && index > 0) {
    return 'form-section';
  }

  if (formControlCount >= 1 && layoutTokens.some((t) => /^(?:flex|grid|gap-|space-x-)/.test(t))) {
    return 'filter-toolbar';
  }

  // Tier 3: Heading, Positional & Layout Token Heuristics
  const hasHeading =
    allDescendantTags.some((t) => /^h[1-3]$/.test(t.toLowerCase())) ||
    components.some((c) => /(?:Title|Heading|Breadcrumb|PageHeader)/i.test(c.name));

  if (hasHeading || (index === 0 && layoutTokens.includes('justify-between'))) {
    return 'page-header';
  }

  const hasActionButtons = components.some(
    (c) => c.tag.toLowerCase() === 'button' || (c.isCustomComponent && /(?:Button|Btn)/i.test(c.name))
  );

  if (
    index === totalSections - 1 &&
    totalSections > 1 &&
    hasActionButtons &&
    layoutTokens.some((t) => t.includes('justify-end') || t.includes('items-center'))
  ) {
    return 'action-footer';
  }

  return 'custom-section';
}

/**
 * Pure Core: Extracts semantic sections from Vue SFC template markup.
 */
export function extractVueSemanticSections(
  templateContent: string,
  startLineOffset = 0
): SemanticSection[] {
  const sections: SemanticSection[] = [];
  if (!templateContent || !templateContent.trim()) return sections;

  try {
    const ast = parseDom(templateContent, { comments: false });
    const topElements = (ast.children || []).filter(
      (child: any) => child && child.type === NodeTypes.ELEMENT
    ) as any[];

    if (topElements.length === 0) return sections;

    // Determine candidate section nodes: unwrap root container (and optional single layout wrapper)
    let sectionNodes: any[] = [];
    if (topElements.length === 1) {
      const rootEl = topElements[0];
      const rootChildren = (rootEl.children || []).filter(
        (c: any) => c && c.type === NodeTypes.ELEMENT
      );
      if (rootChildren.length === 1) {
        const innerChildren = (rootChildren[0].children || []).filter(
          (c: any) => c && c.type === NodeTypes.ELEMENT
        );
        sectionNodes = innerChildren.length >= 2 ? innerChildren : rootChildren;
      } else if (rootChildren.length > 0) {
        sectionNodes = rootChildren;
      } else {
        sectionNodes = [rootEl];
      }
    } else {
      sectionNodes = topElements;
    }

    for (let idx = 0; idx < sectionNodes.length; idx++) {
      const secNode = sectionNodes[idx];
      const secTag = String(secNode.tag);
      const secLine = (secNode.loc?.start?.line || 1) + startLineOffset;
      const secStaticClass = extractVueStaticClass(secNode);
      const secLayoutTokens = filterLayoutTokens(secStaticClass);

      const components: ComponentInstanceRef[] = [];
      const allDescendantTags: string[] = [];
      let hasLoopDirective = false;

      function walkSection(node: any, isRootOfSection: boolean, activeConditional?: string) {
        if (!node || node.type !== NodeTypes.ELEMENT) return;
        const tag = String(node.tag);
        const line = (node.loc?.start?.line || 1) + startLineOffset;

        if (!isRootOfSection && tag.toLowerCase() !== 'template') {
          allDescendantTags.push(tag.toLowerCase());
        }

        const propsList: string[] = [];
        const eventsList: string[] = [];
        let conditional: string | undefined = activeConditional;
        let staticClass = '';

        for (const prop of node.props || []) {
          if (prop.type === NodeTypes.ATTRIBUTE) {
            if (prop.name === 'class' && prop.value?.content) {
              staticClass = prop.value.content;
            } else if (prop.name && !['key', 'ref', 'id'].includes(prop.name)) {
              propsList.push(prop.name);
            }
          } else if (prop.type === NodeTypes.DIRECTIVE) {
            if (prop.name === 'for') {
              hasLoopDirective = true;
            } else if (['if', 'else-if', 'else', 'show'].includes(prop.name)) {
              const expr = prop.exp?.content ? `: ${prop.exp.content}` : '';
              conditional = `v-${prop.name}${expr}`;
            } else if (prop.name === 'on' && prop.arg?.content) {
              eventsList.push(prop.arg.content);
            } else if (prop.name === 'model') {
              const modelArg = prop.arg?.content ? `:${prop.arg.content}` : '';
              propsList.push(`v-model${modelArg}`);
              eventsList.push(`update:${prop.arg?.content || 'modelValue'}`);
            } else if (prop.name === 'bind' && prop.arg?.content) {
              if (prop.arg.content !== 'class' && prop.arg.content !== 'key' && prop.arg.content !== 'style') {
                propsList.push(prop.arg.content);
              }
            }
          }
        }

        const isCustom = isCustomComponentTag(tag);
        const isInteractiveRaw = !isCustom && INTERACTIVE_RAW_PRIMITIVES.has(tag.toLowerCase());

        if (!isRootOfSection || isCustom || isInteractiveRaw) {
          if (isCustom || isInteractiveRaw) {
            const elemTokens = filterLayoutTokens(staticClass);
            components.push({
              name: normalizeComponentName(tag),
              tag,
              isCustomComponent: isCustom,
              line,
              props: propsList,
              events: eventsList,
              conditional,
              layoutTokens: elemTokens.length > 0 ? elemTokens : undefined,
            });
          }
        }

        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            walkSection(child, false, conditional);
          }
        }
      }

      walkSection(secNode, true);

      const kind = classifySemanticSection(
        secTag,
        secLayoutTokens,
        components,
        allDescendantTags,
        hasLoopDirective,
        idx,
        sectionNodes.length
      );

      const rawHtmlPrimitives = components.filter(
        (c) => !c.isCustomComponent && INTERACTIVE_RAW_PRIMITIVES.has(c.tag.toLowerCase())
      );

      sections.push({
        kind,
        tag: secTag,
        line: secLine,
        layoutTokens: secLayoutTokens,
        components,
        rawHtmlPrimitives,
      });
    }
  } catch {
    // Fallback safely on malformed template
  }

  return sections;
}

function extractVueStaticClass(node: any): string {
  for (const prop of node.props || []) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class' && prop.value?.content) {
      return prop.value.content;
    }
  }
  return '';
}

/**
 * Pure helper: Extracts the outer <template>...</template> content from a Vue SFC
 * using balanced tag-depth scanning so nested <template #slot> or <template v-if>
 * blocks never truncate the template prematurely.
 */
export function extractOuterVueTemplate(
  sfcContent: string
): { content: string; lineOffset: number } | null {
  const openRegex = /<template\b[^>]*>/gi;
  const firstMatch = openRegex.exec(sfcContent);
  if (!firstMatch) return null;

  const contentStart = firstMatch.index + firstMatch[0].length;
  const lineOffset = sfcContent.slice(0, firstMatch.index).split('\n').length - 1;

  const tagRegex = /<\/?template\b[^>]*>/gi;
  tagRegex.lastIndex = contentStart;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(sfcContent)) !== null) {
    const token = match[0];
    if (token.startsWith('</')) {
      depth--;
      if (depth === 0) {
        return {
          content: sfcContent.slice(contentStart, match.index),
          lineOffset,
        };
      }
    } else if (!token.endsWith('/>')) {
      depth++;
    }
  }

  return null;
}

/**
 * Pure helper: Locates the primary JSX root of a React component while avoiding:
 * 1) Overwriting by nested `.map(() => <JSX />)` or render callbacks inside the JSX tree.
 * 2) Overwriting by small early-return guards (e.g. `if (loading) return <Spinner />`).
 */
function findPrimaryJsxRoot(
  sourceFile: ts.SourceFile
): ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement | undefined {
  let bestRoot: ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement | undefined;
  let bestSpan = -1;

  function considerCandidate(expr: ts.Expression) {
    const unwrapped = unwrapParenthesized(expr);
    if (
      ts.isJsxElement(unwrapped) ||
      ts.isJsxFragment(unwrapped) ||
      ts.isJsxSelfClosingElement(unwrapped)
    ) {
      const span = unwrapped.getEnd() - unwrapped.getStart(sourceFile);
      if (span > bestSpan) {
        bestSpan = span;
        bestRoot = unwrapped;
      }
      return true;
    }
    return false;
  }

  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      if (considerCandidate(node.expression)) {
        return;
      }
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      if (considerCandidate(node.body)) {
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bestRoot;
}

/**
 * Pure Core: Extracts semantic sections from React JSX/TSX source code using TypeScript AST.
 */
export function extractReactSemanticSections(content: string): SemanticSection[] {
  const sections: SemanticSection[] = [];
  if (!content || !content.trim()) return sections;

  try {
    const sourceFile = ts.createSourceFile(
      'component.tsx',
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const rootJsx = findPrimaryJsxRoot(sourceFile);
    if (!rootJsx) return sections;

    const topChildren = getJsxElementChildren(rootJsx);
    let sectionNodes: ts.JsxChild[] = [];

    if (topChildren.length === 1 && ts.isJsxElement(topChildren[0])) {
      const inner = getJsxElementChildren(topChildren[0]);
      sectionNodes = inner.length >= 2 ? inner : topChildren;
    } else if (topChildren.length > 0) {
      sectionNodes = topChildren;
    } else {
      sectionNodes = [rootJsx as any];
    }

    for (let idx = 0; idx < sectionNodes.length; idx++) {
      const secNode = sectionNodes[idx];
      const secTag = getJsxTagName(secNode) || 'div';
      const secLine = sourceFile.getLineAndCharacterOfPosition(secNode.getStart(sourceFile)).line + 1;
      const secStaticClass = extractJsxStaticClass(secNode, sourceFile);
      const secLayoutTokens = filterLayoutTokens(secStaticClass);

      const components: ComponentInstanceRef[] = [];
      const allDescendantTags: string[] = [];
      let hasLoopDirective = false;

      function walkJsxSection(node: ts.Node, isRootOfSection: boolean, activeConditional?: string) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === 'map') {
            hasLoopDirective = true;
          }
        }

        let nextConditional = activeConditional;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          nextConditional = `jsx-if: ${node.left.getText(sourceFile)}`;
        } else if (ts.isConditionalExpression(node)) {
          nextConditional = `jsx-ternary: ${node.condition.getText(sourceFile)}`;
        }

        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
          const opening = ts.isJsxElement(node) ? node.openingElement : node;
          const tag = opening.tagName.getText(sourceFile);
          const line = sourceFile.getLineAndCharacterOfPosition(opening.getStart(sourceFile)).line + 1;

          if (!isRootOfSection) {
            allDescendantTags.push(tag.toLowerCase());
          }

          const propsList: string[] = [];
          const eventsList: string[] = [];
          let staticClass = '';

          for (const attr of opening.attributes.properties) {
            if (ts.isJsxAttribute(attr)) {
              const attrName = attr.name.getText(sourceFile);
              if (attrName === 'className' || attrName === 'class') {
                if (attr.initializer && ts.isStringLiteral(attr.initializer)) {
                  staticClass = attr.initializer.text;
                }
              } else if (/^on[A-Z]/.test(attrName)) {
                eventsList.push(attrName.slice(2).toLowerCase());
              } else if (!['key', 'ref', 'id'].includes(attrName)) {
                propsList.push(attrName);
              }
            }
          }

          const isCustom = isCustomComponentTag(tag);
          const isInteractiveRaw = !isCustom && INTERACTIVE_RAW_PRIMITIVES.has(tag.toLowerCase());

          if (!isRootOfSection || isCustom || isInteractiveRaw) {
            if (isCustom || isInteractiveRaw) {
              const elemTokens = filterLayoutTokens(staticClass);
              components.push({
                name: normalizeComponentName(tag),
                tag,
                isCustomComponent: isCustom,
                line,
                props: propsList,
                events: eventsList,
                conditional: nextConditional,
                layoutTokens: elemTokens.length > 0 ? elemTokens : undefined,
              });
            }
          }
        }

        ts.forEachChild(node, (child) => walkJsxSection(child, false, nextConditional));
      }

      walkJsxSection(secNode, true);

      const kind = classifySemanticSection(
        secTag,
        secLayoutTokens,
        components,
        allDescendantTags,
        hasLoopDirective,
        idx,
        sectionNodes.length
      );

      const rawHtmlPrimitives = components.filter(
        (c) => !c.isCustomComponent && INTERACTIVE_RAW_PRIMITIVES.has(c.tag.toLowerCase())
      );

      sections.push({
        kind,
        tag: secTag,
        line: secLine,
        layoutTokens: secLayoutTokens,
        components,
        rawHtmlPrimitives,
      });
    }
  } catch {
    // Fallback safely on malformed JSX
  }

  return sections;
}

function unwrapParenthesized(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (ts.isParenthesizedExpression(curr)) {
    curr = curr.expression;
  }
  return curr;
}

function getJsxElementChildren(
  node: ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement
): ts.JsxChild[] {
  if (ts.isJsxSelfClosingElement(node)) return [];
  const result: ts.JsxChild[] = [];
  for (const child of node.children) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      result.push(child);
    } else if (ts.isJsxExpression(child) && child.expression) {
      result.push(child);
    }
  }
  return result;
}

function getJsxTagName(node: ts.Node): string | undefined {
  if (ts.isJsxElement(node)) {
    return node.openingElement.tagName.getText();
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node.tagName.getText();
  }
  return undefined;
}

function extractJsxStaticClass(node: ts.Node, sourceFile: ts.SourceFile): string {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : undefined;
  if (!opening) return '';

  for (const attr of opening.attributes.properties) {
    if (ts.isJsxAttribute(attr)) {
      const name = attr.name.getText(sourceFile);
      if ((name === 'className' || name === 'class') && attr.initializer && ts.isStringLiteral(attr.initializer)) {
        return attr.initializer.text;
      }
    }
  }
  return '';
}

/**
 * Pure Core: Extracts a full PageArchetype from raw file content.
 */
export function extractPageArchetypeFromSource(
  filePath: string,
  content: string,
  framework?: 'vue' | 'react' | 'astro' | 'unknown'
): PageArchetype {
  const ext = extname(filePath).toLowerCase();
  const resolvedFramework: PageArchetype['framework'] =
    framework && framework !== 'unknown'
      ? framework
      : ext === '.vue'
        ? 'vue'
        : ext === '.astro'
          ? 'astro'
          : ext === '.tsx' || ext === '.jsx'
            ? 'react'
            : 'unknown';

  let rootWrapper: RootWrapperLayout | undefined;
  let sections: SemanticSection[] = [];

  if (resolvedFramework === 'vue') {
    const outerTemplate = extractOuterVueTemplate(content);
    if (outerTemplate) {
      const { content: tContent, lineOffset: tLineOffset } = outerTemplate;

      try {
        const ast = parseDom(tContent, { comments: false });
        const firstEl = (ast.children || []).find((c: any) => c && c.type === NodeTypes.ELEMENT) as any;
        if (firstEl) {
          const staticClass = extractVueStaticClass(firstEl);
          const rootLine = (firstEl.loc?.start?.line || 1) + tLineOffset;
          rootWrapper = {
            tag: String(firstEl.tag),
            layoutTokens: filterLayoutTokens(staticClass),
            rawClass: staticClass || undefined,
            line: rootLine,
          };
        }
      } catch {}

      sections = extractVueSemanticSections(tContent, tLineOffset);
    }
  } else if (resolvedFramework === 'react' || resolvedFramework === 'astro') {
    try {
      const sourceFile = ts.createSourceFile(
        'component.tsx',
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const rootJsx = findPrimaryJsxRoot(sourceFile);
      if (rootJsx && (ts.isJsxElement(rootJsx) || ts.isJsxSelfClosingElement(rootJsx))) {
        const tagName = getJsxTagName(rootJsx) || 'div';
        const staticClass = extractJsxStaticClass(rootJsx, sourceFile);
        const rootLine = sourceFile.getLineAndCharacterOfPosition(rootJsx.getStart(sourceFile)).line + 1;
        rootWrapper = {
          tag: tagName,
          layoutTokens: filterLayoutTokens(staticClass),
          rawClass: staticClass || undefined,
          line: rootLine,
        };
      }
    } catch {}

    if (!rootWrapper) {
      const rootTagMatch = content.match(/return\s*\(\s*<([a-zA-Z0-9_.-]+)([^>]*?)>/);
      if (rootTagMatch) {
        const tagName = rootTagMatch[1];
        const attrs = rootTagMatch[2];
        const classMatch = attrs.match(/(?:className|class)=["']([^"']+)["']/);
        const staticClass = classMatch ? classMatch[1] : '';
        rootWrapper = {
          tag: tagName,
          layoutTokens: filterLayoutTokens(staticClass),
          rawClass: staticClass || undefined,
        };
      }
    }
    sections = extractReactSemanticSections(content);
  }

  return {
    filePath,
    framework: resolvedFramework,
    rootWrapper,
    sections,
  };
}

/**
 * Pure Core: Deterministic structural diff engine between a target PageArchetype and an exemplar PageArchetype.
 */
export function diffPageArchetypes(
  target: PageArchetype,
  exemplar: PageArchetype
): ArchetypeAuditResult {
  const violations: ArchetypeDriftViolation[] = [];

  // Rule 1: CONTAINER_DNA_MISMATCH
  const exemplarDna = (exemplar.rootWrapper?.layoutTokens || []).filter((t) =>
    /^(?:max-w-|container|px-|py-|p-|space-y-|gap-)/.test(t)
  );
  const targetDnaSet = new Set(target.rootWrapper?.layoutTokens || []);
  if (exemplarDna.length > 0) {
    const missingDna = exemplarDna.filter((t) => !targetDnaSet.has(t));
    if (missingDna.length > 0) {
      violations.push({
        code: 'CONTAINER_DNA_MISMATCH',
        severity: 'warning',
        line: target.rootWrapper?.line ?? target.sections[0]?.line ?? 1,
        message: `Root container diverges from exemplar layout DNA (missing: ${missingDna.join(', ')}).`,
        expected: exemplarDna.join(' '),
        actual: (target.rootWrapper?.layoutTokens || []).join(' ') || '(none)',
        fixRecommendation: `Align root <${target.rootWrapper?.tag || 'div'}> layout classes with exemplar: "${exemplarDna.join(' ')}".`,
      });
    }
  }

  // Rule 2: MISSING_SEMANTIC_SECTION
  const exemplarSemanticKinds = exemplar.sections
    .map((s) => s.kind)
    .filter((k): k is SectionKind => k !== 'custom-section');
  const targetKindsSet = new Set(target.sections.map((s) => s.kind));

  const seenExemplarKinds = new Set<SectionKind>();
  for (const sec of exemplar.sections) {
    if (sec.kind === 'custom-section' || seenExemplarKinds.has(sec.kind)) continue;
    seenExemplarKinds.add(sec.kind);

    if (!targetKindsSet.has(sec.kind)) {
      const exemplarCustomNames = sec.components
        .filter((c) => c.isCustomComponent)
        .map((c) => `<${c.name}>`)
        .join(', ');
      violations.push({
        code: 'MISSING_SEMANTIC_SECTION',
        severity: 'error',
        section: sec.kind,
        message: `Target page is missing mandatory '${sec.kind}' section present in exemplar.`,
        expected: `Section '${sec.kind}' (${exemplarCustomNames || `<${sec.tag}>`})`,
        actual: 'missing',
        fixRecommendation: `Add a '${sec.kind}' section matching exemplar (${exemplarCustomNames || `<${sec.tag}>`}).`,
      });
    }
  }

  // Rule 3: SECTION_ORDER_DRIFT
  const sharedExemplarOrder = exemplarSemanticKinds.filter(
    (k, i, arr) => arr.indexOf(k) === i && targetKindsSet.has(k)
  );
  const sharedTargetOrder = target.sections
    .map((s) => s.kind)
    .filter((k, i, arr) => k !== 'custom-section' && arr.indexOf(k) === i && seenExemplarKinds.has(k));

  if (
    sharedExemplarOrder.length >= 2 &&
    sharedExemplarOrder.length === sharedTargetOrder.length &&
    sharedExemplarOrder.some((k, idx) => sharedTargetOrder[idx] !== k)
  ) {
    const firstMismatchSection = target.sections.find((s) => s.kind === sharedTargetOrder[0]);
    violations.push({
      code: 'SECTION_ORDER_DRIFT',
      severity: 'warning',
      line: firstMismatchSection?.line,
      message: `Semantic section vertical order diverges from exemplar flow.`,
      expected: sharedExemplarOrder.join(' -> '),
      actual: sharedTargetOrder.join(' -> '),
      fixRecommendation: `Reorder page sections to match exemplar hierarchy: ${sharedExemplarOrder.join(' -> ')}.`,
    });
  }

  // Build lookup of custom Design System components used across the exemplar
  const exemplarAllCustom = exemplar.sections.flatMap((s) =>
    s.components.filter((c) => c.isCustomComponent)
  );

  // Rule 4: RAW_HTML_SUBSTITUTION
  for (const targetSec of target.sections) {
    const matchingExemplarSec = exemplar.sections.find((s) => s.kind === targetSec.kind);
    const candidateCustomPool = matchingExemplarSec
      ? [
          ...matchingExemplarSec.components.filter((c) => c.isCustomComponent),
          ...exemplarAllCustom,
        ]
      : exemplarAllCustom;

    for (const rawPrim of targetSec.rawHtmlPrimitives) {
      const rawTag = rawPrim.tag.toLowerCase();
      const roleRegex = PRIMITIVE_ROLE_PATTERNS[rawTag];
      if (!roleRegex) continue;

      const exemplarReplacement = candidateCustomPool.find((c) => roleRegex.test(c.name));
      if (exemplarReplacement) {
        violations.push({
          code: 'RAW_HTML_SUBSTITUTION',
          severity: 'error',
          section: targetSec.kind,
          line: rawPrim.line,
          message: `Raw HTML <${rawTag}> used in '${targetSec.kind}' where exemplar uses Design System component <${exemplarReplacement.name}>.`,
          expected: `<${exemplarReplacement.name}>`,
          actual: `<${rawTag}>`,
          fixRecommendation: `Replace raw <${rawTag}> at line ${rawPrim.line} with <${exemplarReplacement.name}>.`,
        });
      }
    }
  }

  // Rule 5: MISSING_COMPANION_COMPONENT
  for (const exSec of exemplar.sections) {
    if (exSec.kind === 'custom-section') continue;
    const targetSec = target.sections.find((s) => s.kind === exSec.kind);
    if (!targetSec) continue;

    const exemplarCompanions = exSec.components.filter(
      (c) => c.isCustomComponent && COMPANION_COMPONENT_REGEX.test(c.name)
    );
    const targetComponentNames = new Set(targetSec.components.map((c) => c.name.toLowerCase()));

    for (const companion of exemplarCompanions) {
      if (!targetComponentNames.has(companion.name.toLowerCase())) {
        violations.push({
          code: 'MISSING_COMPANION_COMPONENT',
          severity: 'warning',
          section: exSec.kind,
          line: targetSec.line,
          message: `Section '${exSec.kind}' is missing companion component <${companion.name}> present in exemplar.`,
          expected: `<${companion.name}>${companion.conditional ? ` (${companion.conditional})` : ''}`,
          actual: 'missing',
          fixRecommendation: `Include <${companion.name}> inside '${exSec.kind}' (e.g. for empty/pagination/loading state consistency).`,
        });
      }
    }
  }

  // Compute deterministic compliance score (0 - 100)
  let penalty = 0;
  for (const v of violations) {
    penalty += v.severity === 'error' ? 20 : 10;
  }
  const score = Math.max(0, 100 - penalty);
  const conforms = !violations.some((v) => v.severity === 'error') && score >= 80;

  return {
    targetFile: target.filePath,
    exemplarFile: exemplar.filePath,
    conforms,
    score,
    targetArchetype: target,
    exemplarArchetype: exemplar,
    violations,
  };
}

/**
 * Pure Core: Formats ArchetypeAuditResult into concise, actionable text.
 */
export function formatArchetypeAuditAsText(result: ArchetypeAuditResult): string {
  const lines: string[] = [];
  const statusIcon = result.conforms ? 'PASS' : 'DRIFT DETECTED';

  lines.push(`### Page Archetype & Structural Drift Audit [${statusIcon} — Score: ${result.score}/100]`);
  lines.push(`- **Target Page:** \`${result.targetFile}\` (${result.targetArchetype.sections.length} sections)`);
  lines.push(`- **Exemplar Page:** \`${result.exemplarFile}\` (${result.exemplarArchetype.sections.length} sections)`);
  lines.push('');

  lines.push('#### Section Hierarchy Comparison');
  const exSummary =
    result.exemplarArchetype.sections
      .map((s) => `${s.kind} (<${s.tag}>: ${s.components.filter((c) => c.isCustomComponent).map((c) => c.name).join(', ') || 'raw'})`)
      .join(' -> ') || '(none)';
  const tgSummary =
    result.targetArchetype.sections
      .map((s) => `${s.kind} (L${s.line} <${s.tag}>: ${s.components.filter((c) => c.isCustomComponent).map((c) => c.name).join(', ') || 'raw'})`)
      .join(' -> ') || '(none)';

  lines.push(`- **Exemplar Flow:** ${exSummary}`);
  lines.push(`- **Target Flow:**   ${tgSummary}`);
  lines.push('');

  if (result.violations.length === 0) {
    lines.push('No structural drift or raw HTML substitutions detected. Target page conforms to exemplar.');
    return lines.join('\n');
  }

  lines.push(`#### Structural Drift Violations (${result.violations.length})`);
  for (const v of result.violations) {
    const loc = v.line ? `L${v.line}` : v.section || 'page';
    lines.push(`- **[${v.severity.toUpperCase()}] ${v.code}** (${loc}): ${v.message}`);
    lines.push(`  - Expected: \`${v.expected}\` | Actual: \`${v.actual}\``);
    lines.push(`  - Fix: ${v.fixRecommendation}`);
  }

  return lines.join('\n');
}

/**
 * Imperative Shell: Auto-discovers the richest sibling page in the same or parent route directory
 * when no explicit exemplarPath is provided.
 */
export async function discoverBestSiblingExemplar(
  targetFile: string,
  workspaceRoot?: string
): Promise<string | null> {
  const absTarget = resolve(targetFile);
  const ext = extname(absTarget).toLowerCase();
  const targetDir = dirname(absTarget);
  const parentDir = dirname(targetDir);

  const searchRoot = workspaceRoot
    ? resolve(workspaceRoot)
    : existsSync(parentDir)
      ? parentDir
      : targetDir;

  const allFiles = await collectFiles(searchRoot);
  const candidates = allFiles.filter(
    (f) => resolve(f) !== absTarget && extname(f).toLowerCase() === ext
  );

  if (candidates.length === 0) return null;

  let bestFile: string | null = null;
  let bestRichness = -1;

  for (const candidate of candidates) {
    try {
      const content = await readSourceFile(candidate);
      const archetype = extractPageArchetypeFromSource(candidate, content);
      const customCount = archetype.sections.reduce(
        (acc, s) => acc + s.components.filter((c) => c.isCustomComponent).length,
        0
      );
      const semanticCount = archetype.sections.filter((s) => s.kind !== 'custom-section').length;
      const sameDirBonus = dirname(resolve(candidate)) === targetDir ? 5 : 0;
      const sameFileNameBonus = basename(candidate) === basename(absTarget) ? 3 : 0;

      const richness = semanticCount * 10 + customCount * 2 + sameDirBonus + sameFileNameBonus;
      if (richness > bestRichness) {
        bestRichness = richness;
        bestFile = candidate;
      }
    } catch {
      continue;
    }
  }

  return bestFile;
}

/**
 * Imperative Shell: Resolves target & exemplar files, runs pure extraction and diffing.
 */
export async function auditPageArchetypeDrift(
  options: AuditArchetypeOptions
): Promise<ArchetypeAuditResult> {
  const absTarget = resolve(options.targetPath);
  if (!existsSync(absTarget)) {
    throw new Error(`Target page file not found: ${absTarget}`);
  }

  const stat = await fs.stat(absTarget);
  if (stat.isDirectory()) {
    throw new Error(
      `Target path '${absTarget}' is a directory. Provide a specific page file (e.g. pages/orders/index.vue) for archetype drift auditing.`
    );
  }

  let absExemplar = options.exemplarPath ? resolve(options.exemplarPath) : null;
  if (!absExemplar) {
    absExemplar = await discoverBestSiblingExemplar(absTarget, options.workspaceRoot);
  }

  if (!absExemplar || !existsSync(absExemplar)) {
    throw new Error(
      `No exemplar page found for '${absTarget}'. Provide 'exemplar_path' explicitly or ensure a sibling page exists in the route directory.`
    );
  }

  const [targetContent, exemplarContent] = await Promise.all([
    readSourceFile(absTarget),
    readSourceFile(absExemplar),
  ]);

  const rootDir = options.workspaceRoot ? resolve(options.workspaceRoot) : dirname(dirname(absTarget));
  const relTarget = relative(rootDir, absTarget).replace(/\\/g, '/') || basename(absTarget);
  const relExemplar = relative(rootDir, absExemplar).replace(/\\/g, '/') || basename(absExemplar);

  const targetArchetype = extractPageArchetypeFromSource(relTarget, targetContent);
  const exemplarArchetype = extractPageArchetypeFromSource(relExemplar, exemplarContent);

  return diffPageArchetypes(targetArchetype, exemplarArchetype);
}

