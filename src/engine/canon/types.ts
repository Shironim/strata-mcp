import type {
  CodePatternDiagnostic,
  Evidence,
  FrontendFramework,
  PatternCategory,
  SourceLineRange,
  SourceRef,
  SourceSnapshot,
  SourceSpan,
} from '../../types';
import { getSourcePosition } from '../source-file';

export interface CanonAuditOptions {
  category?: PatternCategory;
  severity?: 'error' | 'warning' | 'info';
  maxDiagnostics?: number;
  framework?: FrontendFramework;
  majorVersion?: number;
}

export type CanonRuleHandler = (
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
) => Promise<CodePatternDiagnostic[]> | CodePatternDiagnostic[];

/**
 * Factory helper for creating fully typed CodePatternDiagnostic instances.
 */
export function createDiagnostic(params: {
  ruleId: string;
  framework: FrontendFramework;
  category: PatternCategory;
  severity: 'error' | 'warning' | 'info';
  snapshot: SourceSnapshot;
  content: string;
  startOffset: number;
  endOffset: number;
  smellTitle: string;
  smellExplanation: string;
  canonSummary: string;
  canonRationale: string;
  canonicalCode: string;
  referenceDoc?: string;
  evidenceMethod?: string;
}): CodePatternDiagnostic {
  const start = getSourcePosition(params.content, params.startOffset);
  const end = getSourcePosition(params.content, params.endOffset);
  const snippet = params.content.slice(params.startOffset, params.endOffset).trim();

  const ref: SourceRef = {
    sha256: params.snapshot.sha256,
    startOffset: params.startOffset,
    endOffset: params.endOffset,
  };

  const lineRange: SourceLineRange | null = params.startOffset === params.endOffset
    ? null
    : {
        startLine: start.line,
        endLine: Math.max(start.line, end.line - (end.column === 1 ? 1 : 0)),
      };

  return {
    ruleId: params.ruleId,
    framework: params.framework,
    category: params.category,
    severity: params.severity,
    fact: {
      snippet,
      span: { start, end },
      lineRange,
      ref,
    },
    smell: {
      title: params.smellTitle,
      explanation: params.smellExplanation,
    },
    canon: {
      summary: params.canonSummary,
      rationale: params.canonRationale,
      canonicalCode: params.canonicalCode,
      ...(params.referenceDoc ? { referenceDoc: params.referenceDoc } : {}),
    },
    evidence: {
      basis: 'source',
      resolution: 'resolved',
      method: params.evidenceMethod || 'ast-pattern-match',
      refs: [ref],
    },
  };
}

