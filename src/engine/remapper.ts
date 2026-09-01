import type { Position, RawMatch, ResolvedMatch, SfcBlock } from '../types';

/**
 * Calculates absolute line and column coordinates from relative block coordinates.
 */
export function remapPosition(
  relativeLine: number,
  relativeColumn: number,
  blockStart: Position
): { line: number; column: number } {
  if (relativeLine <= 1) {
    return {
      line: blockStart.line,
      column: blockStart.column + relativeColumn - 1,
    };
  }

  return {
    line: blockStart.line + relativeLine - 1,
    column: relativeColumn,
  };
}

/**
 * Remaps a raw match from a local block to the original file's absolute line and column numbers.
 */
export function remapMatch(
  rawMatch: RawMatch,
  block: SfcBlock,
  filePath: string
): ResolvedMatch {
  const start = remapPosition(rawMatch.line, rawMatch.column, block.loc.start);

  let endLine: number | undefined;
  let endColumn: number | undefined;

  if (rawMatch.endLine !== undefined && rawMatch.endColumn !== undefined) {
    const end = remapPosition(rawMatch.endLine, rawMatch.endColumn, block.loc.start);
    endLine = end.line;
    endColumn = end.column;
  }

  return {
    file: filePath,
    line: start.line,
    column: start.column,
    endLine,
    endColumn,
    blockType: block.type,
    snippet: rawMatch.text,
    clientDirective: rawMatch.clientDirective,
  };
}

/**
 * Remaps an array of raw matches.
 */
export function remapMatches(
  rawMatches: RawMatch[],
  block: SfcBlock,
  filePath: string
): ResolvedMatch[] {
  return rawMatches.map((match) => remapMatch(match, block, filePath));
}

/**
 * Remaps matches produced from a template expression snippet back to the original file.
 * `expressionStart` is the expression's line/column relative to the template block content.
 */
export function remapTemplateExpressionMatches(
  rawMatches: RawMatch[],
  templateBlock: SfcBlock,
  expressionStart: { line: number; column: number },
  filePath: string
): ResolvedMatch[] {
  const start = remapPosition(
    expressionStart.line,
    expressionStart.column,
    templateBlock.loc.start
  );

  const expressionBlock: SfcBlock = {
    type: 'template',
    content: '',
    lang: 'ts',
    loc: {
      start: { line: start.line, column: start.column, offset: 0 },
      end: { line: start.line, column: start.column, offset: 0 },
    },
  };

  return remapMatches(rawMatches, expressionBlock, filePath);
}
