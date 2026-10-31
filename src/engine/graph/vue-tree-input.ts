import { parse as parseTemplate, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { parseVueSource } from '../vue-parser';

/** Validates SFC structure and supported template syntax, not script types or runtime behavior. */
export function inspectVueTreeInput(content: string, filename: string): {
  code: 'VUE_PARSE_FAILED' | 'VUE_TEMPLATE_UNSUPPORTED'; reason: string;
} | null {
  const { descriptor, errors } = parseVueSource(content, { filename, sourceMap: false });
  if (errors.length) {
    return { code: 'VUE_PARSE_FAILED', reason: `Vue SFC could not be parsed: ${errors.map(error => typeof error === 'string' ? error : error.message).join('; ')}` };
  }
  const template = descriptor.template;
  if (!template) return null;
  if (template.src || (template.lang && template.lang !== 'html')) {
    return { code: 'VUE_TEMPLATE_UNSUPPORTED', reason: 'Tree traversal does not analyze external templates or template languages other than HTML.' };
  }
  const templateErrors: string[] = [];
  parseTemplate(template.content, { onError: error => { templateErrors.push(error.message); } });
  return templateErrors.length
    ? { code: 'VUE_PARSE_FAILED', reason: `Vue template could not be parsed: ${templateErrors.join('; ')}` }
    : null;
}

export interface VueDynamicTreeInput {
  kind: 'static-is' | 'bound-is' | 'dynamic-argument' | 'object-binding';
  argument: string | null;
  expression: string;
  startOffset: number;
  endOffset: number;
}

/** Inventories selection inputs, including bindings that may supply is; never resolves runtime identity. */
export function collectVueDynamicTreeInputs(content: string, filename: string): VueDynamicTreeInput[] {
  const { descriptor } = parseVueSource(content, { filename, sourceMap: false });
  const template = descriptor.template;
  if (!template || template.src || (template.lang && template.lang !== 'html')) return [];
  const templateOffset = template.loc.start.offset;
  const inputs: VueDynamicTreeInput[] = [];
  const root = parseTemplate(template.content);
  function visit(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT && node.tag === 'component') {
      for (const prop of node.props) {
        let kind: VueDynamicTreeInput['kind'] | undefined;
        let expression = '';
        let argument: string | null = null;
        if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is') {
          kind = 'static-is';
          expression = prop.value?.content ?? '';
          argument = 'is';
        } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind') {
          expression = prop.exp?.loc.source ?? '';
          if (!prop.arg) kind = 'object-binding';
          else if (prop.arg.type === NodeTypes.SIMPLE_EXPRESSION) {
            argument = prop.arg.content;
            if (!prop.arg.isStatic) kind = 'dynamic-argument';
            else if (argument === 'is') kind = 'bound-is';
          }
        }
        if (kind) {
          inputs.push({ kind, argument, expression,
            startOffset: templateOffset + prop.loc.start.offset,
            endOffset: templateOffset + prop.loc.end.offset });
        }
      }
    }
    if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT) {
      for (const child of node.children) visit(child);
    }
  }
  visit(root);
  return inputs;
}
