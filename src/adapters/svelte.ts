import type { parse } from 'svelte/compiler';
import { lineStarts, positionFromLineStarts } from '../utils/source-position';
import type { TemplateExpression } from '../engine/template';
import { parseSvelte } from '../engine/svelte-sfc';
import type { SfcBlock, SvelteDescriptor } from '../types';
import type { DocumentAdapter, DocumentType, FrontendFramework } from './types';

export class SvelteDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'svelte-sfc';
  readonly framework: FrontendFramework = 'svelte';
  private readonly descriptor: SvelteDescriptor;

  private fragment?: ReturnType<typeof parse>['fragment'];

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.descriptor = parseSvelte(content, filePath, fragment => { this.fragment = fragment; });
  }

  getScriptBlocks(): SfcBlock[] {
    const blocks: SfcBlock[] = [];
    if (this.descriptor.module) blocks.push(this.descriptor.module);
    if (this.descriptor.instance) blocks.push(this.descriptor.instance);
    return blocks;
  }

  getDescriptor(): SvelteDescriptor {
    return this.descriptor;
  }

  getTemplateBlock(): SfcBlock | null {
    return this.descriptor.template;
  }

  getSearchExpressions(): TemplateExpression[] {
    const template = this.descriptor.template;
    if (!template || !this.fragment) return [];
    const starts = lineStarts(template.content);
    const bom = this.descriptor.rawContent.charCodeAt(0) === 0xFEFF ? 1 : 0;
    const expressions: TemplateExpression[] = [];
    const add = (node: { start: number; end: number }) => {
      const start = node.start + bom - template.loc.start.offset;
      const end = node.end + bom - template.loc.start.offset;
      if (start >= 0 && end > start && end <= template.content.length) {
        expressions.push({ content: template.content.slice(start, end), start: positionFromLineStarts(starts, start) });
      }
    };
    function visit(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (['expression', 'test', 'key'].includes(key) && value && typeof value === 'object' && 'start' in value && 'end' in value) {
          add(value as { start: number; end: number });
        } else if (!['loc', 'metadata', 'parent'].includes(key)) visit(value);
      }
    }
    visit(this.fragment);
    return expressions;
  }

  isJsx(): boolean {
    return false;
  }
}

