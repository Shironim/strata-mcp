import { parse } from '@vue/compiler-sfc';
import type { SfcDescriptor, SfcBlock, SourceLocation } from '../types';

function createLocation(loc: {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}): SourceLocation {
  return {
    start: {
      line: loc.start.line,
      column: loc.start.column,
      offset: loc.start.offset,
    },
    end: {
      line: loc.end.line,
      column: loc.end.column,
      offset: loc.end.offset,
    },
  };
}

/**
 * Parses raw Vue Single File Component (SFC) content into structured blocks.
 */
export function parseSfc(rawContent: string, filename: string = 'anonymous.vue'): SfcDescriptor {
  const { descriptor } = parse(rawContent, {
    filename,
    sourceMap: false,
    pad: false,
  });

  const template: SfcBlock | null = descriptor.template
    ? {
        type: 'template',
        content: descriptor.template.content,
        lang: descriptor.template.lang || 'html',
        loc: createLocation(descriptor.template.loc),
        attrs: descriptor.template.attrs,
      }
    : null;

  const script: SfcBlock | null = descriptor.script
    ? {
        type: 'script',
        content: descriptor.script.content,
        lang: descriptor.script.lang || 'js',
        loc: createLocation(descriptor.script.loc),
        attrs: descriptor.script.attrs,
      }
    : null;

  const scriptSetup: SfcBlock | null = descriptor.scriptSetup
    ? {
        type: 'scriptSetup',
        content: descriptor.scriptSetup.content,
        lang: descriptor.scriptSetup.lang || 'js',
        loc: createLocation(descriptor.scriptSetup.loc),
        attrs: descriptor.scriptSetup.attrs,
      }
    : null;

  const styles: SfcBlock[] = descriptor.styles.map((style) => ({
    type: 'style',
    content: style.content,
    lang: style.lang || 'css',
    loc: createLocation(style.loc),
    scoped: Boolean(style.scoped),
    module: style.module,
    attrs: style.attrs,
  }));

  const customBlocks: SfcBlock[] = descriptor.customBlocks.map((block) => ({
    type: 'custom',
    content: block.content,
    lang: block.lang || 'text',
    loc: createLocation(block.loc),
    attrs: block.attrs,
  }));

  return {
    filename,
    rawContent,
    template,
    script,
    scriptSetup,
    styles,
    customBlocks,
  };
}

/**
 * Returns all active script blocks (regular script and/or script setup).
 */
export function getAllScriptBlocks(descriptor: SfcDescriptor): SfcBlock[] {
  const blocks: SfcBlock[] = [];
  if (descriptor.script) blocks.push(descriptor.script);
  if (descriptor.scriptSetup) blocks.push(descriptor.scriptSetup);
  return blocks;
}
