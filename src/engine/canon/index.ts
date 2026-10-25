import type { CodePatternDiagnostic, FrontendFramework, SourceSnapshot } from '../../types';
import { detectFrameworkWithEvidence } from '../framework-detector';
import { checkAstroRules } from './rules-astro';
import { checkNextRules } from './rules-next';
import { checkNuxtRules } from './rules-nuxt';
import { checkReactRules } from './rules-react';
import { checkSolidRules } from './rules-solid';
import { checkSvelteRules } from './rules-svelte';
import { checkVueRules } from './rules-vue';
import type { CanonAuditOptions, CanonRuleHandler } from './types';

export * from './types';

const frameworkRuleMap: Record<FrontendFramework, CanonRuleHandler[]> = {
  vue: [checkVueRules],
  nuxt: [checkVueRules, checkNuxtRules],
  react: [checkReactRules],
  next: [checkReactRules, checkNextRules],
  astro: [checkAstroRules],
  svelte: [checkSvelteRules],
  solid: [checkSolidRules],
  unknown: [],
};

/**
 * Centrally executes canonical pattern diagnostics against a source file snapshot.
 * Structures findings strictly as: Fact (exact source ref) -> Smell -> Canon (canonical standard).
 */
export async function runCanonAudit(
  snapshot: SourceSnapshot,
  content: string,
  explicitFramework?: FrontendFramework,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const fwEvidence = detectFrameworkWithEvidence(snapshot.file, content);
  const fw = explicitFramework || fwEvidence.framework;
  const majorVersion = options?.majorVersion ?? fwEvidence.majorVersion;
  const mergedOptions: CanonAuditOptions = {
    ...options,
    ...(majorVersion !== undefined ? { majorVersion } : {}),
  };
  const handlers = frameworkRuleMap[fw] || [];

  const results: CodePatternDiagnostic[] = [];
  for (const handler of handlers) {
    const list = await handler(snapshot, content, mergedOptions);
    results.push(...list);
  }

  let filtered = results;
  if (options?.category) {
    filtered = filtered.filter(d => d.category === options.category);
  }
  if (options?.severity) {
    filtered = filtered.filter(d => d.severity === options.severity);
  }
  if (options?.maxDiagnostics && options.maxDiagnostics > 0) {
    filtered = filtered.slice(0, options.maxDiagnostics);
  }

  return filtered;
}

