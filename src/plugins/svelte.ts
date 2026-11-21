import { extname } from 'node:path';
import { parse as parseSvelteCompiler } from 'svelte/compiler';
import { VirtualDocumentBuilder } from './virtual-doc';
import type {
  FrameworkPlugin,
  ProjectionOmission,
  Tier1FileFacts,
  Tier1TemplateComponentUsage,
  VirtualDocument,
} from './types';

interface SvelteScanResult {
  componentUsages: Tier1TemplateComponentUsage[];
  slots: string[];
  omissions: ProjectionOmission[];
}

function projectSvelteSfc(
  filePath: string,
  content: string,
  sourceHash: string
): { doc: VirtualDocument; scan: SvelteScanResult } {
  const builder = new VirtualDocumentBuilder(filePath, content, sourceHash, 'svelte');
  const componentUsages: Tier1TemplateComponentUsage[] = [];
  const slots = new Set<string>();
  const omissions: ProjectionOmission[] = [];

  let ast: any;
  try {
    try {
      ast = parseSvelteCompiler(content, { modern: true, filename: filePath, loose: true });
    } catch {
      ast = parseSvelteCompiler(content, { modern: true, filename: filePath });
    }
  } catch (err) {
    const om: ProjectionOmission = {
      code: 'PARSE_DIAGNOSTIC',
      originalStart: 0,
      originalEnd: content.length,
      reason: `Svelte parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
    omissions.push(om);
    builder.addOmission(om);
    return {
      doc: builder.build(),
      scan: { componentUsages, slots: [], omissions },
    };
  }

  const emitScriptBlock = (scriptNode: any, kind: 'script' | 'script-setup') => {
    if (!scriptNode?.content) return;
    const start: number = scriptNode.content.start;
    const end: number = scriptNode.content.end;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      builder.appendMapped(start, end, kind).appendSynthetic('\n');
    }
  };

  emitScriptBlock(ast.module, 'script');
  emitScriptBlock(ast.instance, 'script-setup');

  if (ast.fragment) {
    builder.appendSynthetic('\nfunction __strata_template__() {\n');

    const emitExpression = (expr: any, kind: 'template-expr' | 'template-model' = 'template-expr') => {
      if (!expr || typeof expr.start !== 'number' || typeof expr.end !== 'number') return;
      if (expr.end <= expr.start) return;
      builder.appendSynthetic('  void (').appendMapped(expr.start, expr.end, kind).appendSynthetic(');\n');
    };

    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }

      if (node.type === 'ExpressionTag' && node.expression) {
        emitExpression(node.expression);
        return;
      }

      if (node.type === 'SlotElement') {
        let slotName = 'default';
        for (const attr of node.attributes ?? []) {
          if (attr.type === 'Attribute' && attr.name === 'name' && Array.isArray(attr.value)) {
            const first = attr.value[0];
            if (first?.data) slotName = first.data;
          }
        }
        slots.add(slotName);
      }

      if (node.type === 'Component') {
        const tagName: string = node.name;
        const tagStart: number = node.start + 1;
        const tagEnd = tagStart + tagName.length;
        const props: Tier1TemplateComponentUsage['props'] = [];
        const events: Tier1TemplateComponentUsage['events'] = [];
        let hasDynamicSpread = false;

        builder.appendSynthetic('  void (<').appendMapped(tagStart, tagEnd, 'template-tag');

        for (const attr of node.attributes ?? []) {
          if (attr.type === 'SpreadAttribute') {
            hasDynamicSpread = true;
            const om: ProjectionOmission = {
              code: 'DYNAMIC_SPREAD',
              originalStart: attr.start,
              originalEnd: attr.end,
              reason: `Svelte spread attribute on <${tagName}>`,
            };
            omissions.push(om);
            builder.addOmission(om);
            if (attr.expression?.start !== undefined && attr.expression?.end !== undefined) {
              builder
                .appendSynthetic(' {...(')
                .appendMapped(attr.expression.start, attr.expression.end, 'template-expr')
                .appendSynthetic(')}');
            }
          } else if (attr.type === 'Attribute') {
            const isEvent = /^on[a-zA-Z]/.test(attr.name);
            if (isEvent) {
              events.push({ name: attr.name, originalStart: attr.start, originalEnd: attr.end });
            } else {
              props.push({
                name: attr.name,
                isDynamic: attr.value !== true && !(Array.isArray(attr.value) && attr.value.every((v: any) => v.type === 'Text')),
                originalStart: attr.start,
                originalEnd: attr.end,
              });
            }

            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(attr.name)) {
              const nameStart = content[attr.start] === '{' ? content.indexOf(attr.name, attr.start) : attr.start;
              const safeNameStart = nameStart >= 0 ? nameStart : attr.start;
              builder
                .appendSynthetic(' ')
                .appendMapped(safeNameStart, safeNameStart + attr.name.length, isEvent ? 'template-event' : 'template-prop');
              if (attr.value?.type === 'ExpressionTag' && attr.value.expression) {
                builder
                  .appendSynthetic('={')
                  .appendMapped(attr.value.expression.start, attr.value.expression.end, 'template-expr')
                  .appendSynthetic('}');
              } else if (Array.isArray(attr.value) && attr.value.length === 1 && attr.value[0]?.type === 'ExpressionTag') {
                const expr = attr.value[0].expression;
                if (expr) {
                  builder
                    .appendSynthetic('={')
                    .appendMapped(expr.start, expr.end, 'template-expr')
                    .appendSynthetic('}');
                }
              } else if (Array.isArray(attr.value) && attr.value.length === 1 && attr.value[0]?.type === 'Text') {
                builder.appendSynthetic(`=${JSON.stringify(attr.value[0].data)}`);
              }
            }
          } else if (attr.type === 'OnDirective') {
            events.push({ name: attr.name, originalStart: attr.start, originalEnd: attr.end });
            if (attr.expression) {
              const handlerName = `on${attr.name.charAt(0).toUpperCase()}${attr.name.slice(1)}`;
              builder
                .appendSynthetic(' ')
                .appendRenamed(handlerName, attr.start, attr.end, 'template-event')
                .appendSynthetic('={')
                .appendMapped(attr.expression.start, attr.expression.end, 'template-expr')
                .appendSynthetic('}');
            }
          } else if (attr.type === 'BindDirective') {
            props.push({
              name: attr.name,
              isDynamic: true,
              originalStart: attr.start,
              originalEnd: attr.end,
            });
            if (attr.expression && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(attr.name)) {
              builder
                .appendSynthetic(` ${attr.name}={`)
                .appendMapped(attr.expression.start, attr.expression.end, 'template-model')
                .appendSynthetic('}');
            }
          }
        }

        builder.appendSynthetic(' />);\n');

        componentUsages.push({
          tagName,
          normalizedName: tagName,
          originalStart: tagStart,
          originalEnd: tagEnd,
          props,
          events,
          hasDynamicSpread,
        });
      } else if (node.type === 'RegularElement') {
        for (const attr of node.attributes ?? []) {
          if (attr.expression) emitExpression(attr.expression);
          if (attr.value?.type === 'ExpressionTag' && attr.value.expression) {
            emitExpression(attr.value.expression);
          } else if (Array.isArray(attr.value)) {
            for (const part of attr.value) {
              if (part?.type === 'ExpressionTag' && part.expression) emitExpression(part.expression);
            }
          }
        }
      } else if (node.type === 'IfBlock' && node.test) {
        emitExpression(node.test);
      } else if (node.type === 'EachBlock' && node.expression) {
        emitExpression(node.expression);
      }

      for (const [key, val] of Object.entries(node)) {
        if (key === 'attributes' || key === 'expression' || key === 'test' || key === 'metadata') continue;
        if (val && typeof val === 'object') visit(val);
      }
    };

    visit(ast.fragment);
    builder.appendSynthetic('}\nvoid __strata_template__;\n');
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

export const sveltePlugin: FrameworkPlugin = {
  id: 'svelte',
  extensions: ['.svelte'] as const,

  matchesFile(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.svelte';
  },

  projectToVirtualTs(filePath: string, content: string, sourceHash: string): VirtualDocument {
    return projectSvelteSfc(filePath, content, sourceHash).doc;
  },

  extractTier1Facts(doc: VirtualDocument, rawContent: string): Tier1FileFacts {
    const { scan } = projectSvelteSfc(doc.originalPath, rawContent, doc.sourceHash);
    return {
      framework: 'svelte',
      renderBoundary: 'universal',
      componentUsages: scan.componentUsages,
      slots: scan.slots,
      omissions: scan.omissions,
    };
  },
};
