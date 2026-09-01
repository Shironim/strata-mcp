import { extname } from 'node:path';
import type { SfcBlock } from '../types';
import type { DocumentAdapter, DocumentType } from './types';

export class ScriptDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'script';
  private readonly content: string;
  private readonly lang: string;
  private readonly isJsxFile: boolean;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.content = content;

    const ext = extname(filePath).toLowerCase();
    this.isJsxFile = ext === '.tsx' || ext === '.jsx';
    this.lang = ext.includes('tsx') ? 'tsx' : ext.includes('jsx') ? 'jsx' : ext.includes('ts') ? 'ts' : 'js';
  }

  getScriptBlocks(): SfcBlock[] {
    const lines = this.content.split('\n');
    const lastLine = lines[lines.length - 1] || '';

    return [
      {
        type: 'script',
        content: this.content,
        lang: this.lang,
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: {
            line: lines.length,
            column: lastLine.length + 1,
            offset: this.content.length,
          },
        },
      },
    ];
  }

  getTemplateBlock(): SfcBlock | null {
    return null;
  }

  isJsx(): boolean {
    return this.isJsxFile;
  }
}
