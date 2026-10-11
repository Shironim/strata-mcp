import { NodeTypes, type RootNode, type TemplateChildNode, type ElementNode } from "@vue/compiler-dom";
import { parseSfc } from "../splitter";

/**
 * Traverses Vue Compiler-DOM AST nodes recursively to visit every ElementNode.
 */
export function walkVueDom(node: RootNode | TemplateChildNode, visitor: (el: ElementNode) => void): void {
  if (node.type === NodeTypes.ELEMENT) {
    visitor(node);
  }
  if (
    node.type === NodeTypes.ROOT ||
    node.type === NodeTypes.ELEMENT ||
    node.type === NodeTypes.FOR
  ) {
    for (const child of node.children) {
      if (typeof child === 'object' && child !== null && 'type' in child) {
        walkVueDom(child as TemplateChildNode, visitor);
      }
    }
  } else if (node.type === NodeTypes.IF) {
    for (const branch of node.branches) {
      for (const child of branch.children) {
        if (typeof child === 'object' && child !== null && 'type' in child) {
          walkVueDom(child as TemplateChildNode, visitor);
        }
      }
    }
  }
}

/**
 * Safely extracts the <template> content from a Vue SFC or returns null if not an SFC.
 */
export function extractVueTemplate(content: string): string | null {
  if (!content.includes('<template')) return null;
  try {
    const sfc = parseSfc(content);
    if (sfc.template?.content) return sfc.template.content;
  } catch {
    // fallback if not a strict SFC
  }
  const match = content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
  return match ? match[1] : null;
}


export type { ExtractedImport } from '../../types';
export {
  STATIC_IMPORT_PATTERN,
  DEFAULT_IMPORT_CLAUSE_PATTERN,
  NAMED_IMPORT_BLOCK_PATTERN,
  NAMED_IMPORT_ITEM_PATTERN,
  DYNAMIC_IMPORT_PATTERN,
  INLINE_ASYNC_COMPONENT_PATTERN,
} from './path-helpers';
