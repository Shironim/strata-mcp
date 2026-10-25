import { extname } from 'node:path';
import { detectFrameworkWithEvidence } from '../engine/framework-detector';
import { getSourcePosition } from '../engine/source-file';
import type { SfcBlock } from '../types';
import type { DocumentAdapter, DocumentType, FrontendFramework } from './types';

export class JsxDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'jsx-module';
  readonly framework: FrontendFramework;
  private readonly content: string;
  private readonly lang: string;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.content = content;

    const ext = extname(filePath).toLowerCase();
    this.lang = ext.includes('tsx') ? 'tsx' : 'jsx';

    const detection = detectFrameworkWithEvidence(filePath, content);
    this.framework = detection.framework;
  }

  getScriptBlocks(): SfcBlock[] {
    return [
      {
        type: 'script',
        content: this.content,
        lang: this.lang,
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: getSourcePosition(this.content, this.content.length),
        },
      },
    ];
  }

  getTemplateBlock(): SfcBlock | null {
    return null;
  }

  isJsx(): boolean {
    return true;
  }
}

