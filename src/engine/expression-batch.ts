import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { remapTemplateExpressionMatches } from './remapper';
import type { TemplateExpression } from './template';
import type { RawMatch, ResolvedMatch, SfcBlock } from '../types';

/**
 * Runs an ast-grep query over all template expressions of a file in a single
 * invocation (batch) and routes each match back to its source expression.
 *
 * A batch is a synthetic JS buffer where every expression sits on its own
 * line(s); `segments` records which buffer line belongs to which expression,
 * so matches can be remapped to their original file positions.
 */

const EXPRESSION_SEPARATOR = '\n';

interface BatchSegment {
  expressionIndex: number;
  /** 1-based line in the synthetic buffer where this expression starts. */
  startLine: number;
  /** 1-based line in the synthetic buffer where this expression ends (inclusive). */
  endLine: number;
}

interface ExpressionBatch {
  code: string;
  segments: BatchSegment[];
}

function buildExpressionBatch(expressions: TemplateExpression[]): ExpressionBatch | null {
  if (expressions.length === 0) return null;

  const lines: string[] = [];
  const segments: BatchSegment[] = [];
  let currentLine = 1;

  for (let i = 0; i < expressions.length; i++) {
    const expression = expressions[i];
    const lineCount = expression.content.split('\n').length;

    segments.push({
      expressionIndex: i,
      startLine: currentLine,
      endLine: currentLine + lineCount - 1,
    });

    lines.push(expression.content);
    currentLine += lineCount; // Expressions are joined by a single newline separator.
  }

  return { code: lines.join(EXPRESSION_SEPARATOR), segments };
}

/** Binary-searches the segment whose line range contains the given buffer line. */
function locateSegment(segments: BatchSegment[], line: number): BatchSegment | null {
  let low = 0;
  let high = segments.length - 1;
  let candidate: BatchSegment | null = null;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].startLine <= line) {
      candidate = segments[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return candidate && line <= candidate.endLine ? candidate : null;
}

/** Converts a buffer-relative match into an expression-relative match. */
function toExpressionMatch(match: RawMatch, segment: BatchSegment): RawMatch {
  const endWithinExpression = match.endLine !== undefined && match.endLine <= segment.endLine;

  return {
    ...match,
    line: match.line - segment.startLine + 1,
    endLine: endWithinExpression ? match.endLine! - segment.startLine + 1 : undefined,
    endColumn: endWithinExpression ? match.endColumn : undefined,
  };
}

function routeBatchMatches(
  rawMatches: RawMatch[],
  segments: BatchSegment[],
  expressions: TemplateExpression[],
  templateBlock: SfcBlock,
  filePath: string
): ResolvedMatch[] {
  const results: ResolvedMatch[] = [];

  for (const match of rawMatches) {
    const segment = locateSegment(segments, match.line);
    if (!segment) continue;

    const expression = expressions[segment.expressionIndex];
    results.push(
      ...remapTemplateExpressionMatches(
        [toExpressionMatch(match, segment)],
        templateBlock,
        expression.start,
        filePath
      )
    );
  }

  return results;
}

/** Runs the query against a single expression (no batch bookkeeping). */
async function querySingleExpression(
  expression: TemplateExpression,
  templateBlock: SfcBlock,
  filePath: string,
  pattern: string | undefined,
  rule: string | undefined,
  language: string | undefined
): Promise<ResolvedMatch[]> {
  try {
    const rawMatches = await executeAstGrep({
      code: expression.content,
      pattern,
      rule,
      language: language || 'ts',
    });
    return remapTemplateExpressionMatches(rawMatches, templateBlock, expression.start, filePath);
  } catch (err) {
    if (isBinaryExecutionError(err)) throw err;
    return [];
  }
}

export interface TemplateExpressionQueryArgs {
  expressions: TemplateExpression[];
  templateBlock: SfcBlock;
  filePath: string;
  pattern?: string;
  rule?: string;
  language?: string;
}

/**
 * Queries all template expressions for `pattern` (or `rule`), batching them into
 * one ast-grep process. Falls back to per-expression queries if the batch fails
 * to parse, preserving isolation for malformed expressions.
 */
export async function queryTemplateExpressions(
  args: TemplateExpressionQueryArgs
): Promise<ResolvedMatch[]> {
  const { expressions, templateBlock, filePath, pattern, rule, language } = args;

  if (expressions.length === 0) return [];
  if (expressions.length === 1) {
    return querySingleExpression(expressions[0], templateBlock, filePath, pattern, rule, language);
  }

  const batch = buildExpressionBatch(expressions);
  if (!batch) return [];

  try {
    const rawMatches = await executeAstGrep({
      code: batch.code,
      pattern,
      rule,
      language: language || 'ts',
    });
    return routeBatchMatches(rawMatches, batch.segments, expressions, templateBlock, filePath);
  } catch (err) {
    if (isBinaryExecutionError(err)) throw err;

    const results: ResolvedMatch[] = [];
    for (const expression of expressions) {
      results.push(
        ...(await querySingleExpression(
          expression,
          templateBlock,
          filePath,
          pattern,
          rule,
          language
        ))
      );
    }
    return results;
  }
}
