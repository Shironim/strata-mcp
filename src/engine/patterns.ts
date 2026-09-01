/**
 * Shared regex building blocks and small string helpers used across the
 * search/parsing engines. Centralised here so identifier/quote rules and
 * regex-escaping live in exactly one place.
 */

/** Matches a JavaScript identifier (letters, digits, underscore, dollar sign). */
export const JS_IDENTIFIER = '[A-Za-z0-9_$]+';

/**
 * Escapes a string so it can be embedded into a RegExp as a literal match.
 * Prevents `.` / `$` / `-` etc. from being interpreted as regex metacharacters.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes a single pair of surrounding `'` or `"` quotes from a string. */
export function stripQuotes(value: string): string {
  return value.replace(/^['"]/, '').replace(/['"]$/, '');
}
