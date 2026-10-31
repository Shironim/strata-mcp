import { parse, NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import type { PatchPlanResult } from '../types';

type Omissions = PatchPlanResult['coverage']['omissions'];

/** Reports unsupported syntax, not proof that a dynamic usage resolves to the target. */
export function collectVuePatchOmissions(
  template: string, templateOffset: number, file: string, sha256: string, targetTags: Set<string>,
): Omissions {
  const root = parse(template); // Malformed templates fail the consumer analysis.
  const omissions: Omissions = [];
  const matches = (tag: string) => targetTags.has(tag) || targetTags.has(tag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
  const add = (node: { loc: { start: { offset: number }; end: { offset: number } } }, code: string, message: string, resolution: 'candidate' | 'unsupported') => {
    omissions.push({ file, code, message, resolution, sourceRef: {
      sha256, startOffset: templateOffset + node.loc.start.offset, endOffset: templateOffset + node.loc.end.offset,
    } });
  };
  function walk(node: RootNode | TemplateChildNode, targetParent: boolean): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      const target = matches(el.tag);
      if (el.tag.toLowerCase() === 'component') {
        add(el, 'DYNAMIC_COMPONENT', 'Dynamic component identity is not resolved; this usage may refer to the target.', 'candidate');
      }
      for (const prop of el.props) {
        if (prop.type !== NodeTypes.DIRECTIVE) continue;
        if (target && (prop.name === 'bind' || prop.name === 'on') && !prop.arg) {
          add(prop, 'OBJECT_FORWARDING', 'Object binding/listener forwarding is not rewritten; review keys and $attrs manually.', 'unsupported');
        } else if ((target || (targetParent && el.tag === 'template')) && prop.arg && prop.arg.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic) {
          add(prop, 'DYNAMIC_ARGUMENT', 'Dynamic directive or slot names are not rewritten.', 'unsupported');
        }
      }
      for (const child of el.children) walk(child, target);
    } else if (node.type === NodeTypes.ROOT) {
      for (const child of node.children) walk(child, targetParent);
    }
  }
  walk(root, false);
  return omissions;
}
