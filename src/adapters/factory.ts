import { extname } from 'node:path';
import type { DocumentAdapter } from './types';
import { VueDocumentAdapter } from './vue';
import { AstroDocumentAdapter } from './astro';
import { SvelteDocumentAdapter } from './svelte';
import { JsxDocumentAdapter } from './jsx';
import { ScriptDocumentAdapter } from './script';

/**
 * Creates the appropriate polymorphic document adapter for a given file path and content.
 */
export function createDocumentAdapter(filePath: string, content: string): DocumentAdapter {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.vue') {
    return new VueDocumentAdapter(filePath, content);
  }

  if (ext === '.astro') {
    return new AstroDocumentAdapter(filePath, content);
  }

  if (ext === '.svelte') {
    return new SvelteDocumentAdapter(filePath, content);
  }

  if (ext === '.tsx' || ext === '.jsx') {
    return new JsxDocumentAdapter(filePath, content);
  }

  return new ScriptDocumentAdapter(filePath, content);
}
