import { parse } from 'svelte/compiler';
import { getSourcePosition } from '../utils/source-position';
import type { SfcBlock } from '../types';
import type { DocumentAdapter, DocumentType, FrontendFramework } from './types';

export class SvelteDocumentAdapter implements DocumentAdapter {
  readonly filePath: string;
  readonly type: DocumentType = 'svelte-sfc';
  readonly framework: FrontendFramework = 'svelte';
  private readonly content: string;
  private scriptBlocks: SfcBlock[] | null = null;
  private templateBlock: SfcBlock | null = null;
  private parsed = false;

  constructor(filePath: string, content: string) {
    this.filePath = filePath;
    this.content = content;
  }

  private ensureParsed(): void {
    if (this.parsed) return;
    this.parsed = true;

    try {
      const ast = parse(this.content, { modern: true });
      const blocks: SfcBlock[] = [];

      // Module script (e.g. <script module> or <script context="module">)
      if ((ast as any).module) {
        const mod = (ast as any).module;
        const scriptContent = mod.content?.body ? this.content.slice(mod.content.start, mod.content.end) : '';
        const langAttr = mod.attributes?.find((a: any) => a.name === 'lang');
        const lang = langAttr?.value?.[0]?.data || 'js';
        blocks.push({
          type: 'script',
          content: scriptContent,
          lang,
          loc: {
            start: getSourcePosition(this.content, mod.start),
            end: getSourcePosition(this.content, mod.end),
          },
          module: true,
        });
      }

      // Instance script (<script>)
      if ((ast as any).instance) {
        const inst = (ast as any).instance;
        const scriptContent = inst.content?.body ? this.content.slice(inst.content.start, inst.content.end) : '';
        const langAttr = inst.attributes?.find((a: any) => a.name === 'lang');
        const lang = langAttr?.value?.[0]?.data || 'js';
        blocks.push({
          type: 'scriptSetup',
          content: scriptContent,
          lang,
          loc: {
            start: getSourcePosition(this.content, inst.start),
            end: getSourcePosition(this.content, inst.end),
          },
        });
      }

      this.scriptBlocks = blocks;

      // Markup / Fragment template
      if ((ast as any).fragment && (ast as any).fragment.nodes?.length > 0) {
        const nodes = (ast as any).fragment.nodes;
        const firstNode = nodes[0];
        const lastNode = nodes[nodes.length - 1];
        const start = firstNode.start;
        const end = lastNode.end;
        this.templateBlock = {
          type: 'template',
          content: this.content.slice(start, end),
          lang: 'html',
          loc: {
            start: getSourcePosition(this.content, start),
            end: getSourcePosition(this.content, end),
          },
        };
      }
    } catch {
      // Fallback regex if parser encounters non-standard or partial syntax
      this.scriptBlocks = [];
      const scriptMatch = this.content.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
      if (scriptMatch && scriptMatch.index !== undefined) {
        const fullStart = scriptMatch.index;
        const fullEnd = fullStart + scriptMatch[0].length;
        const langMatch = scriptMatch[1].match(/\blang=['"]([^'"]+)['"]/i);
        this.scriptBlocks.push({
          type: 'script',
          content: scriptMatch[2],
          lang: langMatch ? langMatch[1] : 'js',
          loc: {
            start: getSourcePosition(this.content, fullStart),
            end: getSourcePosition(this.content, fullEnd),
          },
        });
      }
    }
  }

  getScriptBlocks(): SfcBlock[] {
    this.ensureParsed();
    return this.scriptBlocks || [];
  }

  getTemplateBlock(): SfcBlock | null {
    this.ensureParsed();
    return this.templateBlock;
  }

  isJsx(): boolean {
    return false;
  }
}

