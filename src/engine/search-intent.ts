import { basename, extname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { collectFiles } from './collector';
import { analyzePropImpact } from './prop-impact';
import { readSourceSnapshot, sliceSourceSnapshot } from './source-file';

/** A deliberately bounded grammar; unsupported wording never broadens to a literal search. */
export function interpretSearchIntent(value: unknown): { component: string; prop: string; operation: 'component-prop-usages' | 'component-prop-omissions' } {
  if (typeof value !== 'string') throw new Error('UNSUPPORTED_SEARCH_INTENT: intent must be a string. Example: "komponen Child yang memakai prop title".');
  const match = value.trim().match(/^(?:komponen|component)\s+([A-Za-z_$][\w$.-]*)\s+(?:yang\s+)?(?:memakai|menggunakan|using|uses)\s+prop\s+([A-Za-z_$][\w$-]*)[.?]?$/i);
  if (match) return { component: match[1]!, prop: match[2]!, operation: 'component-prop-usages' };
  const omission = value.trim().match(/^(?:komponen|component)\s+([A-Za-z_$][\w$.-]*)\s+(?:yang\s+)?(?:tanpa|tidak\s+(?:memakai|menggunakan)|omitting|without)\s+prop\s+([A-Za-z_$][\w$-]*)[.?]?$/i);
  if (omission) return { component: omission[1]!, prop: omission[2]!, operation: 'component-prop-omissions' };
  throw new Error('UNSUPPORTED_SEARCH_INTENT: supported examples are "komponen Child yang memakai prop title", "component Child using prop title", "komponen Child tanpa prop title" and "component Child omitting prop title". Use explicit pattern/component/rule_yaml for other searches.');
}

export async function findByIntent(intent: unknown, workspace: string) {
  const interpreted = interpretSearchIntent(intent);
  const scope = resolve(workspace);
  if (!(await stat(scope)).isDirectory()) throw new Error('INVALID_INTENT_SCOPE: path must be a workspace directory; use its containing directory.');
  const candidates = (await collectFiles(scope)).filter(file => /\.(vue|tsx|jsx|astro|svelte)$/.test(file)
    && basename(file, extname(file)) === interpreted.component).sort();
  if (candidates.length > 1) throw new Error(`AMBIGUOUS_INTENT_COMPONENT: narrow path to select one target. Candidates: ${candidates.join(', ')}`);
  if (!candidates.length) throw new Error('INTENT_COMPONENT_NOT_FOUND: no component with that exact basename was discovered in scope. Check path, spelling and ignore rules; this does not establish runtime absence.');
  const target = candidates[0]!;
  if (!target.endsWith('.vue')) throw new Error('UNSUPPORTED_INTENT_FRAMEWORK: prop intent currently analyzes Vue HTML templates only; use explicit search for this target.');
  const impact = await analyzePropImpact({ target, workspace: scope,
    props: [{ name: interpreted.prop, required: false, type: 'unknown' }], detail: 'full' });
  const matches = [];
  const prop = impact.props[0]!;
  const selected = interpreted.operation === 'component-prop-omissions'
    ? (prop.omissions ?? []).map(item => ({ ...item, resolution: 'resolved' as const,
      reason: 'Explicit static target render has no explicit binding for this prop and no unresolved forwarding or dynamic prop/model argument.' }))
    : prop.usages ?? [];
  for (const usage of selected) {
    try {
      const { snapshot, content } = await readSourceSnapshot(usage.file);
      const snippet = sliceSourceSnapshot(snapshot, content, usage.sourceRef);
      const before = content.slice(0, usage.sourceRef.startOffset);
      matches.push({ file: usage.file, line: before.split('\n').length, column: before.length - before.lastIndexOf('\n'),
        snippet, resolution: usage.resolution, reason: usage.reason, sourceRef: usage.sourceRef });
    } catch {
      impact.freshness = 'stale';
      impact.diagnostics.push({ file: usage.file, code: 'INTENT_SOURCE_CHANGED', reason: 'A selected render or usage changed before source retrieval; repeat the request.' });
    }
  }
  return { matches, matchCount: matches.length, interpretation: { grammar: interpreted.operation === 'component-prop-omissions' ? 'component-prop-omission-v1' : 'component-prop-v1', input: intent,
    query: { operation: interpreted.operation, target, prop: interpreted.prop, scope } },
    coverage: { completeness: 'partial', diagnostics: impact.diagnostics, limitations: impact.limitations,
      propSupply: { omittedRenderCount: prop.omittedRenderCount, omittedConsumerCount: prop.omittedConsumerCount,
        indeterminateRenderCount: prop.indeterminateRenderCount, candidateUsageCount: prop.candidateUsageCount,
        boundary: 'Omissions describe static supply at resolved render sites, not runtime execution or a missing required-prop diagnosis. Candidate renders and indeterminate supply do not establish omission; counts are observed in the collected scope only.' } },
    impactIdentity: impact.inputIdentity, inputFreshness: impact.freshness };
}
