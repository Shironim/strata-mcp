import type { DocumentType, FrontendFramework, SfcBlock } from '../types';

export type { DocumentType, FrontendFramework };

import type { TemplateExpression } from '../engine/template';

export interface DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType;
  readonly framework?: FrontendFramework;
  getScriptBlocks(): SfcBlock[];
  getTemplateBlock(): SfcBlock | null;
  getSearchScriptBlocks?(): SfcBlock[];
  getSearchExpressions?(): TemplateExpression[];
  isJsx(): boolean;
}
