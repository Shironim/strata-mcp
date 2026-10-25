import { parseSvelte } from '../engine/svelte-sfc';
import type { SfcBlock, SvelteDescriptor } from '../types';
import type { DocumentAdapter, DocumentType, FrontendFramework } from './types';

export class SvelteDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'svelte-sfc';
  readonly framework: FrontendFramework = 'svelte';
  private readonly descriptor: SvelteDescriptor;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.descriptor = parseSvelte(content, filePath);
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

  isJsx(): boolean {
    return false;
  }
}

