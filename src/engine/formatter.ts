import type { ResolvedMatch } from '../types';

/**
 * Formats match results as token-efficient human-readable text.
 */
export function formatMatchesAsText(matches: ResolvedMatch[]): string {
  if (matches.length === 0) {
    return 'No matches found.';
  }

  return matches
    .map((m) => {
      const directive = m.clientDirective ? ` [${m.clientDirective}]` : '';
      return `${m.file}:${m.line}:${m.column}${directive} - ${m.snippet}`;
    })
    .join('\n');
}
