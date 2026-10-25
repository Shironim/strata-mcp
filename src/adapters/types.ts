import type { DocumentType, FrontendFramework, SfcBlock } from '../types';

export type { DocumentType, FrontendFramework };

export interface DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType;
  readonly framework?: FrontendFramework;
  getScriptBlocks(): SfcBlock[];
  getTemplateBlock(): SfcBlock | null;
  isJsx(): boolean;
}
