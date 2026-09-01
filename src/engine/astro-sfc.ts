import type { AstroDescriptor, SfcBlock, SourceLocation } from '../types';

/**
 * Calculates 1-based line and column from an offset within a string.
 */
function getLineAndColumn(text: string, offset: number): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  const line = lines.length;
  const lastLine = lines[lines.length - 1];
  const column = (lastLine ? lastLine.length : 0) + 1;
  return { line, column };
}

/**
 * Parses an Astro component file (.astro) into its frontmatter and template blocks
 * with exact coordinate and offset preservation.
 */
export function parseAstro(rawContent: string, filename: string = 'anonymous.astro'): AstroDescriptor {
  // Check if file starts with frontmatter fence
  if (!rawContent.startsWith('---')) {
    // No frontmatter: entire file is template
    const templateLoc: SourceLocation = {
      start: { line: 1, column: 1, offset: 0 },
      end: {
        ...getLineAndColumn(rawContent, rawContent.length),
        offset: rawContent.length,
      },
    };

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
    };
  }

  // Find end of the first line (opening fence)
  const firstNewlineMatch = rawContent.match(/^---\r?\n/);
  if (!firstNewlineMatch) {
    // Malformed opening fence
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
    };
  }

  const frontmatterStartOffset = firstNewlineMatch[0].length;

  // Search for closing fence: a newline followed by `---`
  const rest = rawContent.slice(frontmatterStartOffset);
  const closingMatch = rest.match(/\r?\n---(?:\r?\n|$)/);

  if (!closingMatch || closingMatch.index === undefined) {
    // No closing fence found
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
    };
  }

  const frontmatterEndOffset = frontmatterStartOffset + closingMatch.index;
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

  const templateStartOffset = frontmatterStartOffset + closingMatch.index + closingMatch[0].length;
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

  return {
    filename,
    rawContent,
    frontmatter: frontmatterBlock,
    template: templateBlock,
  };
}
