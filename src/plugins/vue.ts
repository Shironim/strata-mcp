import { extname } from 'node:path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { NodeTypes, parse as parseVueDom } from '@vue/compiler-dom';
import { VirtualDocumentBuilder } from './virtual-doc';
import type {
  FrameworkPlugin,
  ProjectionOmission,
  Tier1FileFacts,
  Tier1TemplateComponentUsage,
  VirtualDocument,
} from './types';

const VUE_BUILTINS = new Set([
  'template',
  'slot',
  'component',
  'transition',
  'transition-group',
  'keep-alive',
  'teleport',
  'suspense',
]);

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'small',
  'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'path', 'g', 'circle',
  'rect', 'line', 'polygon', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

function kebabToPascal(tag: string): string {
  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function isCustomVueComponent(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (VUE_BUILTINS.has(lower) || HTML_TAGS.has(lower)) return false;
  return /^[A-Z]/.test(tag) || tag.includes('-');
}

function safeJsxPropName(raw: string): string {
  const camel = kebabToCamel(raw);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(camel) ? camel : '';
}

function safeEventHandlerName(raw: string): string {
  const camel = kebabToCamel(raw);
  if (!camel || !/^[A-Za-z0-9_$]+$/.test(camel)) return '';
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

interface VueProjectionScan {
  componentUsages: Tier1TemplateComponentUsage[];
  slots: string[];
  omissions: ProjectionOmission[];
}

function projectVueSfc(
  filePath: string,
  content: string,
  sourceHash: string
): { doc: VirtualDocument; scan: VueProjectionScan } {
  const builder = new VirtualDocumentBuilder(filePath, content, sourceHash, 'vue');
  const componentUsages: Tier1TemplateComponentUsage[] = [];
  const slots = new Set<string>();
  const omissions: ProjectionOmission[] = [];

  const parsed = parseSfc(content, { filename: filePath, pad: false });
  for (const err of parsed.errors) {
    omissions.push({
      code: 'PARSE_DIAGNOSTIC',
      originalStart: 0,
      originalEnd: 0,
      reason: typeof err === 'string' ? err : err.message,
    });
  }

  const { descriptor } = parsed;

  if (descriptor.script) {
    const start = descriptor.script.loc.start.offset;
    const end = descriptor.script.loc.end.offset;
    builder.appendMapped(start, end, 'script').appendSynthetic('\n');
  }

  if (descriptor.scriptSetup) {
    const start = descriptor.scriptSetup.loc.start.offset;
    const end = descriptor.scriptSetup.loc.end.offset;
    builder.appendMapped(start, end, 'script-setup').appendSynthetic('\n');
  }

  if (descriptor.template) {
    const tplBase = descriptor.template.loc.start.offset;
    const tplContent = descriptor.template.content;

    builder.appendSynthetic('\nfunction __strata_template__() {\n');

    try {
      const domAst = parseVueDom(tplContent, { comments: false });

      const visitNode = (node: any): void => {
        if (!node || typeof node !== 'object') return;

        if (node.type === NodeTypes.INTERPOLATION) {
          const exp = node.content;
          if (exp?.type === NodeTypes.SIMPLE_EXPRESSION && exp.content?.trim()) {
            const s = tplBase + exp.loc.start.offset;
            const e = tplBase + exp.loc.end.offset;
            builder.appendSynthetic('  void (').appendMapped(s, e, 'template-expr').appendSynthetic(');\n');
          }
          return;
        }

        if (node.type === NodeTypes.ELEMENT) {
          const tag: string = node.tag;

          if (tag === 'slot') {
            let slotName = 'default';
            for (const p of node.props ?? []) {
              if (p.type === NodeTypes.ATTRIBUTE && p.name === 'name' && p.value?.content) {
                slotName = p.value.content;
              }
            }
            slots.add(slotName);
          }

          const isComponent = isCustomVueComponent(tag);
          const normalizedTag = isComponent ? kebabToPascal(tag) : tag;
          const tagStart = tplBase + node.loc.start.offset + 1; // skip '<'
          const tagEnd = tagStart + tag.length;

          if (isComponent) {
            const compProps: Tier1TemplateComponentUsage['props'] = [];
            const compEvents: Tier1TemplateComponentUsage['events'] = [];
            let hasDynamicSpread = false;

            builder.appendSynthetic('  void (<');
            if (normalizedTag === tag) {
              builder.appendMapped(tagStart, tagEnd, 'template-tag');
            } else {
              builder.appendRenamed(normalizedTag, tagStart, tagEnd, 'template-tag');
            }

            for (const prop of node.props ?? []) {
              if (prop.type === NodeTypes.ATTRIBUTE) {
                const jsxProp = safeJsxPropName(prop.name);
                const pStart = tplBase + prop.loc.start.offset;
                const pEnd = tplBase + prop.loc.end.offset;
                compProps.push({
                  name: kebabToCamel(prop.name),
                  isDynamic: false,
                  originalStart: pStart,
                  originalEnd: pEnd,
                });
                if (jsxProp) {
                  builder.appendSynthetic(' ');
                  builder.appendRenamed(jsxProp, pStart, pStart + prop.name.length, 'template-prop');
                  if (prop.value?.content !== undefined) {
                    builder.appendSynthetic(`=${JSON.stringify(prop.value.content)}`);
                  }
                }
              } else if (prop.type === NodeTypes.DIRECTIVE) {
                const dirName: string = prop.name;
                const pStart = tplBase + prop.loc.start.offset;
                const pEnd = tplBase + prop.loc.end.offset;
                const exp = prop.exp;
                const expStart = exp?.loc ? tplBase + exp.loc.start.offset : pStart;
                const expEnd = exp?.loc ? tplBase + exp.loc.end.offset : pEnd;

                if (dirName === 'bind') {
                  if (!prop.arg) {
                    // v-bind="obj" dynamic spread
                    hasDynamicSpread = true;
                    const om: ProjectionOmission = {
                      code: 'DYNAMIC_SPREAD',
                      originalStart: pStart,
                      originalEnd: pEnd,
                      reason: `Vue dynamic v-bind spread on <${tag}>`,
                    };
                    omissions.push(om);
                    builder.addOmission(om);
                    if (exp?.content?.trim()) {
                      builder
                        .appendSynthetic(' {...(')
                        .appendMapped(expStart, expEnd, 'template-expr')
                        .appendSynthetic(')}');
                    }
                  } else if (prop.arg.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) {
                    const rawArg: string = prop.arg.content;
                    const jsxProp = safeJsxPropName(rawArg);
                    const argStart = tplBase + prop.arg.loc.start.offset;
                    const argEnd = tplBase + prop.arg.loc.end.offset;
                    compProps.push({
                      name: kebabToCamel(rawArg),
                      isDynamic: true,
                      originalStart: pStart,
                      originalEnd: pEnd,
                    });
                    if (jsxProp) {
                      builder.appendSynthetic(' ');
                      builder.appendRenamed(jsxProp, argStart, argEnd, 'template-prop');
                      if (exp?.content?.trim()) {
                        builder
                          .appendSynthetic('={')
                          .appendMapped(expStart, expEnd, 'template-expr')
                          .appendSynthetic('}');
                      }
                    }
                  }
                } else if (dirName === 'on' && prop.arg?.isStatic) {
                  const rawEvent: string = prop.arg.content;
                  const handlerProp = safeEventHandlerName(rawEvent);
                  const argStart = tplBase + prop.arg.loc.start.offset;
                  const argEnd = tplBase + prop.arg.loc.end.offset;
                  compEvents.push({
                    name: rawEvent,
                    originalStart: pStart,
                    originalEnd: pEnd,
                  });
                  if (handlerProp && exp?.content?.trim()) {
                    builder.appendSynthetic(' ');
                    builder.appendRenamed(handlerProp, argStart, argEnd, 'template-event');
                    builder
                      .appendSynthetic('={() => (')
                      .appendMapped(expStart, expEnd, 'template-expr')
                      .appendSynthetic(')}');
                  }
                } else if (dirName === 'model') {
                  const rawArg: string = prop.arg?.isStatic ? prop.arg.content : 'modelValue';
                  const jsxProp = safeJsxPropName(rawArg);
                  compProps.push({
                    name: kebabToCamel(rawArg),
                    isDynamic: true,
                    originalStart: pStart,
                    originalEnd: pEnd,
                  });
                  if (jsxProp && exp?.content?.trim()) {
                    builder.appendSynthetic(` ${jsxProp}={`);
                    builder.appendMapped(expStart, expEnd, 'template-model');
                    builder.appendSynthetic('}');
                  }
                }
              }
            }

            builder.appendSynthetic(' />);\n');

            // Also emit structural directive expressions on the component (v-if, v-show)
            for (const prop of node.props ?? []) {
              if (
                prop.type === NodeTypes.DIRECTIVE &&
                (prop.name === 'if' || prop.name === 'else-if' || prop.name === 'show') &&
                prop.exp?.content?.trim()
              ) {
                builder
                  .appendSynthetic('  void (')
                  .appendMapped(
                    tplBase + prop.exp.loc.start.offset,
                    tplBase + prop.exp.loc.end.offset,
                    'template-expr'
                  )
                  .appendSynthetic(');\n');
              }
            }

            componentUsages.push({
              tagName: tag,
              normalizedName: normalizedTag,
              originalStart: tagStart,
              originalEnd: tagEnd,
              props: compProps,
              events: compEvents,
              hasDynamicSpread,
            });
          } else {
            // Native HTML element: emit directive expressions so references to script bindings are preserved
            for (const prop of node.props ?? []) {
              if (prop.type === NodeTypes.DIRECTIVE && prop.exp?.content?.trim()) {
                const expStart = tplBase + prop.exp.loc.start.offset;
                const expEnd = tplBase + prop.exp.loc.end.offset;
                if (prop.name === 'for') {
                  // v-for="item in items" -> extract source expression after `in`/`of`
                  const m = /\b(?:in|of)\s+([\s\S]+)$/.exec(prop.exp.content);
                  if (m) {
                    const srcOffset = prop.exp.content.lastIndexOf(m[1]);
                    builder
                      .appendSynthetic('  void (')
                      .appendMapped(expStart + srcOffset, expStart + srcOffset + m[1].length, 'template-expr')
                      .appendSynthetic(');\n');
                  }
                } else {
                  builder
                    .appendSynthetic('  void (')
                    .appendMapped(expStart, expEnd, 'template-expr')
                    .appendSynthetic(');\n');
                }
              }
            }
          }

          for (const child of node.children ?? []) {
            visitNode(child);
          }
          return;
        }

        for (const child of node.children ?? []) {
          visitNode(child);
        }
      };

      visitNode(domAst);
    } catch (err) {
      const om: ProjectionOmission = {
        code: 'PARSE_DIAGNOSTIC',
        originalStart: tplBase,
        originalEnd: descriptor.template.loc.end.offset,
        reason: `Vue template parse error: ${err instanceof Error ? err.message : String(err)}`,
      };
      omissions.push(om);
      builder.addOmission(om);
    }

    builder.appendSynthetic('}\nvoid __strata_template__;\n');
  }

  for (const om of omissions) {
    // ensure non-duplicate additions (builder already received DYNAMIC_SPREAD & template parse errors)
    if (om.code === 'PARSE_DIAGNOSTIC' && om.originalStart === 0 && om.originalEnd === 0) {
      builder.addOmission(om);
    }
  }

  // Ensure SFC modules always expose a default export for TypeScript consumers
  const scriptText = `${descriptor.script?.content ?? ''}\n${descriptor.scriptSetup?.content ?? ''}`;
  if (!/\bexport\s+default\b/.test(scriptText)) {
    builder.appendSynthetic('\nexport default {} as Record<string, any>;\n');
  }

  return {
    doc: builder.build(),
    scan: {
      componentUsages,
      slots: [...slots],
      omissions,
    },
  };
}

export const vuePlugin: FrameworkPlugin = {
  id: 'vue',
  extensions: ['.vue'] as const,

  matchesFile(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.vue';
  },

  projectToVirtualTs(filePath: string, content: string, sourceHash: string): VirtualDocument {
    return projectVueSfc(filePath, content, sourceHash).doc;
  },

  extractTier1Facts(doc: VirtualDocument, rawContent: string): Tier1FileFacts {
    const { scan } = projectVueSfc(doc.originalPath, rawContent, doc.sourceHash);
    return {
      framework: 'vue',
      renderBoundary: 'universal',
      componentUsages: scan.componentUsages,
      slots: scan.slots,
      omissions: scan.omissions,
    };
  },
};
