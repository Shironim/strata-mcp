import type { AstroDescriptor, SfcBlock, SourceLocation } from '../types';
import { getSourcePosition } from '../utils/source-position';

/**
 * Calculates 1-based line and column from an offset within a string.
 */
function getLineAndColumn(text: string, offset: number): { line: number; column: number } {
  const { line, column } = getSourcePosition(text, offset);
  return { line, column };
}

/**
 * Parses HTML tag attribute string into a key-value dictionary with support
 * for boolean attributes, quoted strings, and nested JSX/Astro brace expressions.
 */
export function parseAstroAttributes(attrString: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  const len = attrString.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(attrString[i])) i++;
    if (i >= len) break;

    const keyStart = i;
    while (i < len && /[a-zA-Z0-9_:@.-]/.test(attrString[i])) i++;
    const key = attrString.slice(keyStart, i);
    if (!key) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(attrString[i])) i++;

    if (i < len && attrString[i] === '=') {
      i++; // skip '='
      while (i < len && /\s/.test(attrString[i])) i++;
      if (i >= len) {
        attrs[key] = '';
        break;
      }

      const quote = attrString[i];
      if (quote === '"' || quote === "'") {
        i++;
        const valStart = i;
        while (i < len && attrString[i] !== quote) {
          if (attrString[i] === '\\') i += 2;
          else i++;
        }
        attrs[key] = attrString.slice(valStart, i);
        if (i < len && attrString[i] === quote) i++;
      } else if (quote === '{') {
        const valStart = i;
        let braceDepth = 0;
        while (i < len) {
          if (attrString[i] === '{') braceDepth++;
          else if (attrString[i] === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        attrs[key] = attrString.slice(valStart, i);
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrString[i])) i++;
        attrs[key] = attrString.slice(valStart, i);
      }
    } else {
      attrs[key] = true;
    }
  }

  return attrs;
}

/**
 * Scans for the closing `---` fence of frontmatter, ignoring any `---` that appears
 * inside string literals, template literals, or TypeScript comments.
 */
function findFrontmatterClosingFence(
  rawContent: string,
  startOffset: number
): { index: number; length: number } | null {
  const len = rawContent.length;
  let i = startOffset;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let templateBraceDepth = 0;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = rawContent[i];
    const next = i + 1 < len ? rawContent[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inSingleQuote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      } else if (ch === '\n') {
        inSingleQuote = false;
      }
      i++;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === '\n') {
        inDoubleQuote = false;
      }
      i++;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        templateBraceDepth++;
        i += 2;
        continue;
      }
      if (templateBraceDepth > 0) {
        if (ch === '{') templateBraceDepth++;
        else if (ch === '}') templateBraceDepth--;
        i++;
        continue;
      }
      if (ch === "\`") {
        inTemplate = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Outside comments and strings
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      i++;
      continue;
    }
    if (ch === "\`") {
      inTemplate = true;
      i++;
      continue;
    }

    // Check for newline followed by closing fence `---`
    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      const newlineLength = ch === '\r' && next === '\n' ? 2 : 1;
      const afterNewline = i + newlineLength;
      if (rawContent.startsWith('---', afterNewline)) {
        const afterFence = afterNewline + 3;
        if (
          afterFence >= len ||
          rawContent[afterFence] === '\n' ||
          (rawContent[afterFence] === '\r' && rawContent[afterFence + 1] === '\n') ||
          rawContent[afterFence] === '\r'
        ) {
          let fenceEndingLength = 3;
          if (rawContent.startsWith('\r\n', afterFence)) {
            fenceEndingLength += 2;
          } else if (rawContent[afterFence] === '\n' || rawContent[afterFence] === '\r') {
            fenceEndingLength += 1;
          }
          return {
            index: i,
            length: newlineLength + fenceEndingLength,
          };
        }
      }
    }

    i++;
  }

  return null;
}

/**
 * Extracts embedded `<script>` and `<style>` blocks in the Astro template
 * with exact coordinate calculations.
 */
function extractEmbeddedBlocks(
  rawContent: string,
  templateStartOffset: number
): { scripts: SfcBlock[]; styles: SfcBlock[] } {
  const scripts: SfcBlock[] = [];
  const styles: SfcBlock[] = [];

  const templateSlice = rawContent.slice(templateStartOffset);
  const htmlCommentRegex = new RegExp('<!' + '--[\\s\\S]*?--' + '>', 'g');
  const templateMasked = templateSlice.replace(htmlCommentRegex, m => m.replace(/[^\r\n]/g, ' '));

  // Script tags: <script ...>...</script>
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(templateMasked)) !== null) {
    const attrString = match[1];
    const openTagLength = match[0].indexOf('>') + 1;
    const contentStartOffset = templateStartOffset + match.index + openTagLength;
    const content = match[2];
    const contentEndOffset = contentStartOffset + content.length;
    const actualContent = rawContent.slice(contentStartOffset, contentEndOffset);

    const attrs = parseAstroAttributes(attrString);
    const lang = attrs.lang ? String(attrs.lang) : 'ts';

    scripts.push({
      type: 'script',
      content: actualContent,
      lang,
      loc: {
        start: { ...getLineAndColumn(rawContent, contentStartOffset), offset: contentStartOffset },
        end: { ...getLineAndColumn(rawContent, contentEndOffset), offset: contentEndOffset },
      },
      attrs,
    });
  }

  // Style tags: <style ...>...</style>
  const styleRegex = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  while ((match = styleRegex.exec(templateMasked)) !== null) {
    const attrString = match[1];
    const openTagLength = match[0].indexOf('>') + 1;
    const contentStartOffset = templateStartOffset + match.index + openTagLength;
    const content = match[2];
    const contentEndOffset = contentStartOffset + content.length;
    const actualContent = rawContent.slice(contentStartOffset, contentEndOffset);

    const attrs = parseAstroAttributes(attrString);
    const lang = attrs.lang ? String(attrs.lang) : 'css';
    const isGlobal = Boolean(attrs['is:global'] || attrs['global']);

    styles.push({
      type: 'style',
      content: actualContent,
      lang,
      loc: {
        start: { ...getLineAndColumn(rawContent, contentStartOffset), offset: contentStartOffset },
        end: { ...getLineAndColumn(rawContent, contentEndOffset), offset: contentEndOffset },
      },
      scoped: !isGlobal,
      attrs,
    });
  }

  return { scripts, styles };
}

/**
 * Parses an Astro component file (.astro) into its frontmatter, template,
 * and embedded script/style blocks with exact coordinate and offset preservation.
 */
export function parseAstro(rawContent: string, filename: string = 'anonymous.astro'): AstroDescriptor {
  const hasBOM = rawContent.charCodeAt(0) === 0xFEFF;
  const contentToScan = hasBOM ? rawContent.slice(1) : rawContent;
  const bomOffset = hasBOM ? 1 : 0;

  // Check if file starts with frontmatter fence
  if (!contentToScan.startsWith('---')) {
    // No frontmatter: entire file is template
    const templateLoc: SourceLocation = {
      start: { line: 1, column: 1, offset: 0 },
      end: {
        ...getLineAndColumn(rawContent, rawContent.length),
        offset: rawContent.length,
      },
    };

    const { scripts, styles } = extractEmbeddedBlocks(rawContent, 0);

    return {
      filename,
      rawContent,
      frontmatter: null,
      template: {
        type: 'astroTemplate',
        content: rawContent,
        lang: 'html',
        loc: templateLoc,
      },
      scripts,
      styles,
    };
  }

  // Find end of the first line (opening fence)
  const firstNewlineMatch = contentToScan.match(/^---\r?\n/);
  if (!firstNewlineMatch) {
    // Malformed opening fence
    const { scripts, styles } = extractEmbeddedBlocks(rawContent, 0);
    return {
      filename,
      rawContent,
      frontmatter: null,
      template: {
        type: 'astroTemplate',
        content: rawContent,
        lang: 'html',
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { ...getLineAndColumn(rawContent, rawContent.length), offset: rawContent.length },
        },
      },
      scripts,
      styles,
      diagnostics: [{ code: 'ASTRO_FRONTMATTER_OPENING_FENCE', message: 'Opening frontmatter fence is not followed by a newline.' }],
    };
  }

  const frontmatterStartOffset = bomOffset + firstNewlineMatch[0].length;

  // Search for closing fence ignoring string literals, template literals, and comments
  const closingMatch = findFrontmatterClosingFence(rawContent, frontmatterStartOffset);

  if (!closingMatch) {
    // No closing fence found
    const { scripts, styles } = extractEmbeddedBlocks(rawContent, 0);
    return {
      filename,
      rawContent,
      frontmatter: null,
      template: {
        type: 'astroTemplate',
        content: rawContent,
        lang: 'html',
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { ...getLineAndColumn(rawContent, rawContent.length), offset: rawContent.length },
        },
      },
      scripts,
      styles,
      diagnostics: [{ code: 'ASTRO_FRONTMATTER_UNCLOSED', message: 'Frontmatter opening fence has no closing fence.' }],
    };
  }

  const frontmatterEndOffset = closingMatch.index;
  const frontmatterContent = rawContent.slice(frontmatterStartOffset, frontmatterEndOffset);

  const frontmatterLoc: SourceLocation = {
    start: {
      ...getLineAndColumn(rawContent, frontmatterStartOffset),
      offset: frontmatterStartOffset,
    },
    end: {
      ...getLineAndColumn(rawContent, frontmatterEndOffset),
      offset: frontmatterEndOffset,
    },
  };

  const frontmatterBlock: SfcBlock = {
    type: 'frontmatter',
    content: frontmatterContent,
    lang: 'ts',
    loc: frontmatterLoc,
  };

  const templateStartOffset = closingMatch.index + closingMatch.length;
  const templateContent = rawContent.slice(templateStartOffset);

  const templateLoc: SourceLocation = {
    start: {
      ...getLineAndColumn(rawContent, templateStartOffset),
      offset: templateStartOffset,
    },
    end: {
      ...getLineAndColumn(rawContent, rawContent.length),
      offset: rawContent.length,
    },
  };

  const templateBlock: SfcBlock = {
    type: 'astroTemplate',
    content: templateContent,
    lang: 'html',
    loc: templateLoc,
  };

  const { scripts, styles } = extractEmbeddedBlocks(rawContent, templateStartOffset);

  return {
    filename,
    rawContent,
    frontmatter: frontmatterBlock,
    template: templateBlock,
    scripts,
    styles,
  };
}
