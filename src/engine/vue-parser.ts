import { parse, parseCache, type SFCParseOptions, type SFCParseResult } from '@vue/compiler-sfc';
import { assertSourceSize } from './source-file';

/** Vue's cache keys include source text; avoid retaining historical revisions. */
export function parseVueSource(source: string, options: SFCParseOptions = {}): SFCParseResult {
  assertSourceSize(Buffer.byteLength(source), options.filename ?? 'anonymous.vue');
  try { return parse(source, options); }
  finally { parseCache.clear(); }
}
