import type { SfcBlock } from '../types';

export type DocumentType = 'vue' | 'astro' | 'script';

export interface DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType;
  getScriptBlocks(): SfcBlock[];
  getTemplateBlock(): SfcBlock | null;
  isJsx(): boolean;
}
