import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import type {
  ComponentLayoutStructure,
  DynamicClassBinding,
  RootWrapperLayout,
  VisibilityDirective,
} from '../types';

/**
 * Regex matching Tailwind layout, geometry, visibility, and positioning utility tokens.
 * Handles responsive and state prefixes (e.g. `md:flex`, `lg:hidden`, `hover:relative`, `dark:flex`).
 */
const LAYOUT_TOKEN_REGEX =
  /^(?:[a-z0-9_-]+:)*(?:flex|inline-flex|grid|inline-grid|block|inline-block|inline|hidden|contents|table|flow-root|flex-col|flex-row|flex-wrap|flex-nowrap|flex-1|flex-auto|flex-initial|flex-none|items-(?:start|end|center|baseline|stretch)|justify-(?:normal|start|end|center|between|around|evenly|stretch)|content-(?:normal|start|end|center|between|around|evenly|baseline|stretch)|self-(?:auto|start|end|center|stretch|baseline)|place-(?:content|items|self)-[a-z0-9_-]+|grow|grow-0|shrink|shrink-0|basis-[a-z0-9_\-\[\]]+|grid-cols-[a-z0-9_\-\[\]]+|grid-rows-[a-z0-9_\-\[\]]+|col-[a-z0-9_\-\[\]]+|col-span-[a-z0-9_\-\[\]]+|row-[a-z0-9_\-\[\]]+|row-span-[a-z0-9_\-\[\]]+|gap-[a-z0-9_\-\[\]]+|gap-x-[a-z0-9_\-\[\]]+|gap-y-[a-z0-9_\-\[\]]+|order-[a-z0-9_\-\[\]]+|static|fixed|absolute|relative|sticky|inset-[a-z0-9_\-\[\]]+|top-[a-z0-9_\-\[\]]+|bottom-[a-z0-9_\-\[\]]+|left-[a-z0-9_\-\[\]]+|right-[a-z0-9_\-\[\]]+|z-[a-z0-9_\-\[\]]+|w-[a-z0-9_\-\[\]]+|min-w-[a-z0-9_\-\[\]]+|max-w-[a-z0-9_\-\[\]]+|h-[a-z0-9_\-\[\]]+|min-h-[a-z0-9_\-\[\]]+|max-h-[a-z0-9_\-\[\]]+|size-[a-z0-9_\-\[\]]+|container|overflow-[a-z0-9_\-\[\]]+|visible|invisible|collapse|p-[a-z0-9_\-\[\]]+|px-[a-z0-9_\-\[\]]+|py-[a-z0-9_\-\[\]]+|pt-[a-z0-9_\-\[\]]+|pb-[a-z0-9_\-\[\]]+|pl-[a-z0-9_\-\[\]]+|pr-[a-z0-9_\-\[\]]+|m-[a-z0-9_\-\[\]]+|mx-[a-z0-9_\-\[\]]+|my-[a-z0-9_\-\[\]]+|mt-[a-z0-9_\-\[\]]+|mb-[a-z0-9_\-\[\]]+|ml-[a-z0-9_\-\[\]]+|mr-[a-z0-9_\-\[\]]+|space-x-[a-z0-9_\-\[\]]+|space-y-[a-z0-9_\-\[\]]+)$/i;

/**
 * Filters a raw class string into deduplicated layout-significant tokens.
 */
export function filterLayoutTokens(classString?: string, maxTokens = 15): string[] {
  if (!classString) return [];
  const tokens = classString
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const matched = new Set<string>();
  for (const token of tokens) {
    if (LAYOUT_TOKEN_REGEX.test(token)) {
      matched.add(token);
    }
  }

  return Array.from(matched).slice(0, maxTokens);
}

/**
 * Parses dynamic class bindings like `{ 'hidden': !isOpen, 'opacity-50': isLoading }`
 * or `isOpen ? 'block' : 'hidden'` into structured binding items.
 */
export function parseDynamicClassContent(
  content: string,
  line: number,
  tag: string,
  directive: ':class' | 'className'
): DynamicClassBinding[] {
  const bindings: DynamicClassBinding[] = [];
  const trimmed = content.trim();

  // Pattern 1: Object syntax `{ 'class-a class-b': condition, 'class-c': condition2 }`
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    // Split by comma at top depth
    const pairs = splitObjectPairs(inner);
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const rawKey = pair.slice(0, colonIdx).trim().replace(/^['"`]|['"`]$/g, '');
      const condition = pair.slice(colonIdx + 1).trim();

      const tokens = filterLayoutTokens(rawKey);
      if (tokens.length > 0 || rawKey.includes('hidden') || rawKey.includes('opacity') || rawKey.includes('flex') || rawKey.includes('block')) {
        bindings.push({
          line,
          tag,
          directive,
          condition,
          tokens: tokens.length > 0 ? tokens : rawKey.split(/\s+/).filter(Boolean),
        });
      }
    }
    return bindings;
  }

  // Pattern 2: Ternary syntax `condition ? 'classTrue' : 'classFalse'`
  const ternaryMatch = trimmed.match(/^([^?]+)\?\s*['"`]([^'"`]+)['"`]\s*:\s*['"`]([^'"`]+)['"`]$/);
  if (ternaryMatch) {
    const condition = ternaryMatch[1].trim();
    const trueTokens = filterLayoutTokens(ternaryMatch[2]);
    const falseTokens = filterLayoutTokens(ternaryMatch[3]);

    if (trueTokens.length > 0 || ternaryMatch[2].includes('hidden')) {
      bindings.push({
        line,
        tag,
        directive,
        condition,
        tokens: trueTokens.length > 0 ? trueTokens : ternaryMatch[2].split(/\s+/).filter(Boolean),
      });
    }
    if (falseTokens.length > 0 || ternaryMatch[3].includes('hidden')) {
      bindings.push({
        line,
        tag,
        directive,
        condition: `!(${condition})`,
        tokens: falseTokens.length > 0 ? falseTokens : ternaryMatch[3].split(/\s+/).filter(Boolean),
      });
    }
    return bindings;
  }

  // Pattern 3: Array syntax `['static-cls', { 'hidden': !isOpen }]`
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    const subObjects = inner.match(/\{[^}]+\}/g);
    if (subObjects) {
      for (const subObj of subObjects) {
        bindings.push(...parseDynamicClassContent(subObj, line, tag, directive));
      }
    }
    return bindings;
  }

  // Fallback: general expression
  const tokens = filterLayoutTokens(trimmed);
  if (tokens.length > 0) {
    bindings.push({
      line,
      tag,
      directive,
      condition: trimmed,
      tokens,
    });
  }

  return bindings;
}

function splitObjectPairs(inner: string): string[] {
  const pairs: string[] = [];
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';
  let current = '';

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (inQuote) {
      current += char;
      if (char === quoteChar && inner[i - 1] !== '\\') {
        inQuote = false;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      inQuote = true;
      quoteChar = char;
      current += char;
      continue;
    }

    if (char === '{' || char === '(' || char === '[') {
      depth++;
      current += char;
      continue;
    }

    if (char === '}' || char === ')' || char === ']') {
      depth--;
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (current.trim()) pairs.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    pairs.push(current.trim());
  }

  return pairs;
}

/**
 * Extracts layout structure from Vue SFC template AST using @vue/compiler-dom.
 */
export function extractVueLayoutStructure(
  templateContent: string,
  startLineOffset = 0
): ComponentLayoutStructure {
  let rootWrapper: RootWrapperLayout | undefined;
  const dynamicBindings: DynamicClassBinding[] = [];
  const visibilityDirectives: VisibilityDirective[] = [];

  try {
    const ast = parseDom(templateContent, { comments: false });

    // Walk AST
    function walk(node: any, depth: number) {
      if (!node) return;

      if (node.type === NodeTypes.ELEMENT) {
        const tagName = String(node.tag);
        const line = (node.loc?.start?.line || 1) + startLineOffset;

        let staticClass = '';
        let dynamicClassContent = '';

        for (const prop of node.props || []) {
          // Static class attribute
          if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class' && prop.value?.content) {
            staticClass = prop.value.content;
          }

          // Dynamic :class binding
          if (
            prop.type === NodeTypes.DIRECTIVE &&
            (prop.name === 'bind' && prop.arg?.content === 'class' || prop.rawName === ':class')
          ) {
            if (prop.exp?.content) {
              dynamicClassContent = prop.exp.content;
              const propLine = (prop.loc?.start?.line || line) + startLineOffset;
              const bindings = parseDynamicClassContent(
                dynamicClassContent,
                propLine,
                tagName,
                ':class'
              );
              dynamicBindings.push(...bindings);
            }
          }

          // Visibility directives (v-show, v-if, v-else-if, v-else)
          if (
            prop.type === NodeTypes.DIRECTIVE &&
            ['show', 'if', 'else-if', 'else'].includes(prop.name)
          ) {
            const propLine = (prop.loc?.start?.line || line) + startLineOffset;
            const directiveName = (`v-${prop.name}`) as VisibilityDirective['directive'];
            const expression = prop.exp?.content || (prop.name === 'else' ? 'true' : '');
            visibilityDirectives.push({
              line: propLine,
              tag: tagName,
              directive: directiveName,
              expression,
            });
          }
        }

        // Set rootWrapper from first top-level element
        if (depth === 0 && !rootWrapper) {
          const layoutTokens = filterLayoutTokens(staticClass);
          rootWrapper = {
            tag: tagName,
            layoutTokens,
            rawClass: staticClass || undefined,
          };
        }

        // Traverse children
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            walk(child, depth + 1);
          }
        }
      }
    }

    if (Array.isArray(ast.children)) {
      for (const child of ast.children) {
        walk(child, 0);
      }
    }
  } catch {
    // If template parsing encounters malformed markup, fallback safely
  }

  return {
    rootWrapper,
    dynamicBindings,
    visibilityDirectives,
  };
}

/**
 * Extracts layout structure from React/JSX/TSX component code.
 */
export function extractReactLayoutStructure(content: string): ComponentLayoutStructure {
  let rootWrapper: RootWrapperLayout | undefined;
  const dynamicBindings: DynamicClassBinding[] = [];
  const visibilityDirectives: VisibilityDirective[] = [];

  const lines = content.split('\n');

  // 1. Find root wrapper tag in JSX return block
  const rootTagMatch = content.match(/return\s*\(\s*<([a-zA-Z0-9_.-]+)([^>]*?)>/);
  if (rootTagMatch) {
    const tagName = rootTagMatch[1];
    const attrs = rootTagMatch[2];
    const classMatch = attrs.match(/className=["']([^"']+)["']/);
    const staticClass = classMatch ? classMatch[1] : '';
    rootWrapper = {
      tag: tagName,
      layoutTokens: filterLayoutTokens(staticClass),
      rawClass: staticClass || undefined,
    };
  }

  // 2. Scan lines for dynamic className expressions
  const dynamicClassRegex = /<([a-zA-Z0-9_.-]+)[^>]*className=\{([^}]+)\}/g;
  for (const match of content.matchAll(dynamicClassRegex)) {
    const tag = match[1];
    const expr = match[2];
    let line = 1;
    let currentLen = 0;
    for (let i = 0; i < lines.length; i++) {
      if (currentLen + lines[i].length + 1 > (match.index || 0)) {
        line = i + 1;
        break;
      }
      currentLen += lines[i].length + 1;
    }

    // Check for cn(...) or clsx(...)
    const helperMatch = expr.match(/(?:cn|clsx)\s*\(([\s\S]*?)\)/);
    if (helperMatch) {
      const args = splitObjectPairs(helperMatch[1]);
      for (const arg of args) {
        if (arg.includes('?') && arg.includes(':')) {
          const ternaryBindings = parseDynamicClassContent(arg, line, tag, 'className');
          dynamicBindings.push(...ternaryBindings);
        } else if (arg.includes('&&')) {
          const andMatch = arg.match(/^([^&]+)&&\s*['"`]([^'"`]+)['"`]$/);
          if (andMatch) {
            const condition = andMatch[1].trim();
            const tokens = filterLayoutTokens(andMatch[2]);
            dynamicBindings.push({
              line,
              tag,
              directive: 'className',
              condition,
              tokens: tokens.length > 0 ? tokens : andMatch[2].split(/\s+/).filter(Boolean),
            });
          }
        } else if (arg.startsWith('{')) {
          dynamicBindings.push(...parseDynamicClassContent(arg, line, tag, 'className'));
        }
      }
    } else {
      dynamicBindings.push(...parseDynamicClassContent(expr, line, tag, 'className'));
    }
  }

  // 3. Scan for conditional rendering `{condition && <Component ...>}`
  const conditionalRenderRegex = /\{([a-zA-Z0-9_$!.]+)\s*&&\s*<([a-zA-Z0-9_.-]+)/g;
  for (const match of content.matchAll(conditionalRenderRegex)) {
    const condition = match[1];
    const tag = match[2];
    let line = 1;
    let currentLen = 0;
    for (let i = 0; i < lines.length; i++) {
      if (currentLen + lines[i].length + 1 > (match.index || 0)) {
        line = i + 1;
        break;
      }
      currentLen += lines[i].length + 1;
    }

    visibilityDirectives.push({
      line,
      tag,
      directive: 'v-if',
      expression: condition,
    });
  }

  return {
    rootWrapper,
    dynamicBindings,
    visibilityDirectives,
  };
}

/**
 * Universal layout structure extractor facade for Vue, React, Astro.
 */
export function extractLayoutStructure(
  filePath: string,
  content: string,
  framework: string,
  templateBlockContent?: string,
  templateStartLine = 0
): ComponentLayoutStructure | undefined {
  if (framework === 'vue') {
    let tContent = templateBlockContent;
    let tLine = templateStartLine;
    if (!tContent) {
      const templateMatch = content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
      if (templateMatch && templateMatch[1]) {
        tContent = templateMatch[1];
        const beforeTemplate = content.slice(0, templateMatch.index || 0);
        tLine = beforeTemplate.split('\n').length;
      }
    }
    if (tContent) {
      return extractVueLayoutStructure(tContent, tLine);
    }
  }

  if (framework === 'react') {
    return extractReactLayoutStructure(content);
  }

  if (framework === 'astro') {
    // Astro uses JSX-like template
    const fenceMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]+/);
    const templatePart = fenceMatch ? content.slice(fenceMatch[0].length) : content;
    return extractReactLayoutStructure(templatePart);
  }

  return undefined;
}
