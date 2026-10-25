import { extname } from 'node:path';
import { getSourcePosition } from '../utils/source-position';
import type { SfcBlock } from '../types';
import type { DocumentAdapter, DocumentType, FrontendFramework } from './types';

export class JsxDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'jsx-module';
  readonly framework: FrontendFramework;
  private readonly content: string;
  private readonly lang: string;

  constructor(filePath: string, content: string, framework?: FrontendFramework) {
    this.filePath = filePath;
    this.content = content;

    const ext = extname(filePath).toLowerCase();
    this.lang = ext.includes('tsx') ? 'tsx' : 'jsx';

    this.framework = framework ?? (content.includes('solid-js') ? 'solid' : 'react');
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

