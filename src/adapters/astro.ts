import { astroOpeningTags } from '../engine/astro-template';
import { lineStarts, positionFromLineStarts } from '../utils/source-position';
import type { TemplateExpression } from '../engine/template';
import { parseAstro } from '../engine/astro-sfc';
import type { AstroDescriptor, FrontendFramework, SfcBlock } from '../types';
import type { DocumentAdapter, DocumentType } from './types';

export class AstroDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'astro';
  readonly framework: FrontendFramework = 'astro';
  private readonly descriptor: AstroDescriptor;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.descriptor = parseAstro(content, filePath);
  }

  getScriptBlocks(): SfcBlock[] {
    return this.descriptor.frontmatter ? [this.descriptor.frontmatter] : [];
  }

  getDescriptor(): AstroDescriptor {
    return this.descriptor;
  }

  getTemplateBlock(): SfcBlock | null {
    return this.descriptor.template;
  }

  private searchRegions?: { expressions: TemplateExpression[]; scripts: SfcBlock[] };

  private getSearchRegions() {
    if (this.searchRegions) return this.searchRegions;
    const template = this.descriptor.template;
    const expressions: TemplateExpression[] = [];
    const scripts = this.getScriptBlocks();
    if (template && !this.descriptor.diagnostics?.length) {
      const starts = lineStarts(template.content);
      const tags = astroOpeningTags(template.content, (start, end) => {
        expressions.push({ content: template.content.slice(start, end), start: positionFromLineStarts(starts, start) });
      });
      const scriptStarts = new Set(tags.filter(tag => tag.name.toLowerCase() === 'script')
        .map(tag => template.loc.start.offset + tag.end));
      for (const block of this.descriptor.scripts ?? []) {
        const attrs = block.attrs ?? {};
        const type = String(attrs.type ?? '').trim().toLowerCase();
        if (scriptStarts.has(block.loc.start.offset) && !('src' in attrs)
          && ['', 'module', 'text/javascript', 'application/javascript', 'text/typescript'].includes(type)
          && /^(?:js|jsx|ts|tsx|javascript|typescript)$/i.test(block.lang)) scripts.push(block);
      }
    }
    return this.searchRegions = { expressions, scripts };
  }

  getSearchScriptBlocks(): SfcBlock[] {
    return this.getSearchRegions().scripts;
  }

  getSearchExpressions(): TemplateExpression[] {
    return this.getSearchRegions().expressions;
  }

  isJsx(): boolean {
    return false;
  }
}
