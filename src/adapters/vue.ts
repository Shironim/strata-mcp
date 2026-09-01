import { parseSfc, getAllScriptBlocks } from '../engine/splitter';
import type { SfcBlock, SfcDescriptor } from '../types';
import type { DocumentAdapter, DocumentType } from './types';

export class VueDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'vue';
  private readonly descriptor: SfcDescriptor;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.descriptor = parseSfc(content, filePath);
  }

  getScriptBlocks(): SfcBlock[] {
    return getAllScriptBlocks(this.descriptor);
  }

  getTemplateBlock(): SfcBlock | null {
    return this.descriptor.template;
  }

  isJsx(): boolean {
    return false;
  }
}
