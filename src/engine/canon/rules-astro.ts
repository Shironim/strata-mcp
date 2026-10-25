import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

/**
 * Astro Canonical Pattern Rules:
 * 1. astro/missing-client-directive: Detects interactive component usage without hydration directive.
 */
export async function checkAstroRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  // Component with interactive handler props passed from Astro without client directive
  const unhydratedComponentRegex = /<([A-Z][A-Za-z0-9_]*)\b(?![^>]*\bclient:)[^>]*\b(onClick|onSubmit|onChange)=/g;
  let match: RegExpExecArray | null;
  while ((match = unhydratedComponentRegex.exec(content)) !== null) {
    const compName = match[1];
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    diagnostics.push(
      createDiagnostic({
        ruleId: 'astro/missing-client-directive',
        framework: 'astro',
        category: 'boundary',
        severity: 'warning',
        snapshot,
        content,
        startOffset,
        endOffset,
        smellTitle: `Astro Component <${compName}> Missing Hydration Directive`,
        smellExplanation: `Passing event listeners to <${compName}> in an Astro file will not execute because Astro components render to zero-JS static HTML by default unless hydrated.`,
        canonSummary: `Add a client directive such as 'client:load', 'client:idle', or 'client:visible'.`,
        canonRationale: 'Astro Islands architecture requires explicit hydration directives for framework components that need browser interactivity.',
        canonicalCode: `<${compName} client:load />`,
        referenceDoc: 'https://docs.astro.build/en/reference/directives-reference/#client-directives',
      })
    );
  }

  return diagnostics;
}

