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

  isJsx(): boolean {
    return false;
  }
}
