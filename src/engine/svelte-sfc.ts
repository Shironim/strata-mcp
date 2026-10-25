import { parse } from 'svelte/compiler';
import { getSourcePosition } from '../utils/source-position';
import type { SfcBlock, SvelteDescriptor } from '../types';

function extractAttributeMap(attributes: any[] | undefined): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  if (!attributes) return result;

  for (const attr of attributes) {
    if (!attr || !attr.name) continue;
    if (attr.value === true || attr.value === undefined) {
      result[attr.name] = true;
    } else if (Array.isArray(attr.value) && attr.value[0]?.data !== undefined) {
      result[attr.name] = attr.value[0].data;
    } else if (typeof attr.value === 'string') {
      result[attr.name] = attr.value;
    } else {
      result[attr.name] = true;
    }
  }

  return result;
}

/**
 * Parses a Svelte component SFC into structured blocks and descriptor.
 * Gracefully handles syntax/compiler errors with diagnostics and regex fallback.
 */
export function parseSvelte(content: string, filename = 'component.svelte'): SvelteDescriptor {
  const diagnostics: Array<{ code: string; message: string }> = [];
  let instanceBlock: SfcBlock | null = null;
  let moduleBlock: SfcBlock | null = null;
  let templateBlock: SfcBlock | null = null;
  const styles: SfcBlock[] = [];

  try {
    let ast: any;
    try {
      ast = parse(content, { modern: true, filename, loose: true });
    } catch {
      ast = parse(content, { modern: true, filename });
    }

    // 1. Module script (<script module> or <script context="module">)
    if (ast.module) {
      const mod = ast.module;
      const start = mod.content?.start ?? mod.start;
      const end = mod.content?.end ?? mod.end;
      const scriptContent = content.slice(start, end);
      const attrs = extractAttributeMap(mod.attributes);
      const lang = typeof attrs.lang === 'string' ? attrs.lang : 'js';

      moduleBlock = {
        type: 'script',
        content: scriptContent,
        lang,
        loc: {
          start: getSourcePosition(content, start),
          end: getSourcePosition(content, end),
        },
        module: true,
        attrs,
      };
    }

    // 2. Instance script (<script>)
    if (ast.instance) {
      const inst = ast.instance;
      const start = inst.content?.start ?? inst.start;
      const end = inst.content?.end ?? inst.end;
      const scriptContent = content.slice(start, end);
      const attrs = extractAttributeMap(inst.attributes);
      const lang = typeof attrs.lang === 'string' ? attrs.lang : 'js';

      instanceBlock = {
        type: 'scriptSetup',
        content: scriptContent,
        lang,
        loc: {
          start: getSourcePosition(content, start),
          end: getSourcePosition(content, end),
        },
        attrs,
      };
    }

    // 3. Fragment / Template
    if (ast.fragment && ast.fragment.nodes && ast.fragment.nodes.length > 0) {
      const nodes = ast.fragment.nodes;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const start = first.start;
      const end = last.end;

      templateBlock = {
        type: 'template',
        content: content.slice(start, end),
        lang: 'html',
        loc: {
          start: getSourcePosition(content, start),
          end: getSourcePosition(content, end),
        },
      };
    }

    // 4. CSS / Style
    if (ast.css) {
      const css = ast.css;
      const start = css.content?.start ?? css.start;
      const end = css.content?.end ?? css.end;
      const styleContent = content.slice(start, end);
      const attrs = extractAttributeMap(css.attributes);
      const lang = typeof attrs.lang === 'string' ? attrs.lang : 'css';

      styles.push({
        type: 'style',
        content: styleContent,
        lang,
        loc: {
          start: getSourcePosition(content, start),
          end: getSourcePosition(content, end),
        },
        scoped: true,
        attrs,
      });
    }
  } catch (error: any) {
    diagnostics.push({
      code: 'SVELTE_PARSE_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });

    // Fallback regex parsing for scripts
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRegex.exec(content)) !== null) {
      const rawAttrs = match[1];
      const body = match[2];
      const fullStart = match.index;
      const fullEnd = fullStart + match[0].length;
      const isModule = /\b(?:context=["']module["']|module\b)/i.test(rawAttrs);
      const langMatch = rawAttrs.match(/\blang=['"]([^'"]+)['"]/i);
      const lang = langMatch ? langMatch[1] : 'js';

      const bodyStart = fullStart + match[0].indexOf(body);
      const bodyEnd = bodyStart + body.length;

      const block: SfcBlock = {
        type: isModule ? 'script' : 'scriptSetup',
        content: body,
        lang,
        loc: {
          start: getSourcePosition(content, bodyStart),
          end: getSourcePosition(content, bodyEnd),
        },
        module: isModule ? true : undefined,
      };

      if (isModule && !moduleBlock) {
        moduleBlock = block;
      } else if (!isModule && !instanceBlock) {
        instanceBlock = block;
      }
    }

    // Fallback regex for style
    const styleRegex = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
    while ((match = styleRegex.exec(content)) !== null) {
      const rawAttrs = match[1];
      const body = match[2];
      const fullStart = match.index;
      const fullEnd = fullStart + match[0].length;
      const langMatch = rawAttrs.match(/\blang=['"]([^'"]+)['"]/i);
      const lang = langMatch ? langMatch[1] : 'css';

      styles.push({
        type: 'style',
        content: body,
        lang,
        loc: {
          start: getSourcePosition(content, fullStart),
          end: getSourcePosition(content, fullEnd),
        },
        scoped: true,
      });
    }
  }

  return {
    filename,
    rawContent: content,
    instance: instanceBlock,
    module: moduleBlock,
    template: templateBlock,
    styles: styles.length > 0 ? styles : undefined,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };
}

