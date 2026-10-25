import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { getProjectEcosystem } from '../framework-detector';
import { findProjectRoot } from '../path-resolver';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

/**
 * Svelte Canonical Pattern Rules:
 * 1. svelte/prefer-runes: In Svelte 5+, flags legacy Svelte 4 reactivity (export let, $: reactive statements) in favor of Runes ($props, $state, $derived).
 */
export async function checkSvelteRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  let svelteMajor = 5; // Default assumption modern Svelte
  try {
    const root = findProjectRoot(snapshot.file);
    const eco = getProjectEcosystem(root);
    if (eco.frameworks.svelte?.major) {
      svelteMajor = eco.frameworks.svelte.major;
    }
  } catch {
    // Default to Svelte 5
  }

  if (svelteMajor >= 5) {
    // Legacy export let in Svelte 5
    const exportLetRegex = /export\s+let\s+([A-Za-z0-9_]+)(?:\s*:\s*[^=;]+)?(?:\s*=\s*[^;]+)?;/g;
    let match: RegExpExecArray | null;
    while ((match = exportLetRegex.exec(content)) !== null) {
      const propName = match[1];
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-runes-props',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Legacy Svelte 4 Prop Syntax in Svelte 5 Project',
          smellExplanation: `Using 'export let ${propName}' is legacy syntax in Svelte 5. Modern Svelte uses the '$props()' rune for type-safe, fine-grained props declaration.`,
          canonSummary: `Replace with 'let { ${propName} } = $props();'`,
          canonRationale: 'Svelte 5 Runes provide universal fine-grained reactivity across both .svelte components and .svelte.js/.svelte.ts modules.',
          canonicalCode: `let { ${propName} } = $props();`,
          referenceDoc: 'https://svelte.dev/docs/svelte/$props',
        })
      );
    }

    // Legacy $: reactive statement in Svelte 5
    const reactiveStatementRegex = /^\s*\$:\s*([A-Za-z0-9_]+)\s*=\s*(.+);/gm;
    while ((match = reactiveStatementRegex.exec(content)) !== null) {
      const varName = match[1];
      const expr = match[2];
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-runes-derived',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Legacy Svelte 4 Reactive Declaration ($:)',
          smellExplanation: `Labelled statement '$: ${varName} = ...' is legacy syntax in Svelte 5. Derived state should use the '$derived()' rune.`,
          canonSummary: `Replace with 'let ${varName} = $derived(${expr});'`,
          canonRationale: 'Runes make reactivity explicit, predictable, and functional inside and outside components.',
          canonicalCode: `let ${varName} = $derived(${expr});`,
          referenceDoc: 'https://svelte.dev/docs/svelte/$derived',
        })
      );
    }
  }

  return diagnostics;
}

