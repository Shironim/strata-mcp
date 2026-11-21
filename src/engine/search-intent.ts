import { basename, extname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { collectFiles } from './collector';
import { analyzePropImpact } from './prop-impact';
import { readSourceSnapshot, sliceSourceSnapshot } from './source-file';

export interface ComponentPropQueryInput {
  component: unknown;
  prop: unknown;
  presence?: unknown;
}

/** Validates structured component + prop supply/omission selector parameters. */
export function parseComponentPropQuery(input: ComponentPropQueryInput): {
  component: string;
  prop: string;
  presence: 'present' | 'omitted';
  operation: 'component-prop-usages' | 'component-prop-omissions';
} {
  const component = typeof input.component === 'string' ? input.component.trim() : '';
  const prop = typeof input.prop === 'string' ? input.prop.trim() : '';
  if (!component || !/^[A-Za-z_$][\w$.-]*$/.test(component) || !prop || !/^[A-Za-z_$][\w$-]*$/.test(prop)) {
    throw new Error('INVALID_COMPONENT_PROP_QUERY: provide valid component and prop_name identifiers (e.g. { component: "Child", prop_name: "title" }).');
  }
  const rawPresence = input.presence === undefined ? 'present' : input.presence;
  if (rawPresence !== 'present' && rawPresence !== 'omitted') {
    throw new Error('INVALID_PROP_PRESENCE: prop_presence must be "present" or "omitted".');
  }
  return {
    component,
    prop,
    presence: rawPresence,
    operation: rawPresence === 'omitted' ? 'component-prop-omissions' : 'component-prop-usages',
  };
}

export async function findByComponentProp(input: ComponentPropQueryInput, workspace: string) {
  const parsed = parseComponentPropQuery(input);
  const scope = resolve(workspace);
  if (!(await stat(scope)).isDirectory()) throw new Error('INVALID_PROP_SEARCH_SCOPE: path must be a workspace directory; use its containing directory.');
  const candidates = (await collectFiles(scope)).filter(file => /\.(vue|tsx|jsx|astro|svelte)$/.test(file)
    && basename(file, extname(file)) === parsed.component).sort();
  if (candidates.length > 1) throw new Error(`AMBIGUOUS_PROP_COMPONENT: narrow path to select one target. Candidates: ${candidates.join(', ')}`);
  if (!candidates.length) throw new Error('PROP_COMPONENT_NOT_FOUND: no component with that exact basename was discovered in scope. Check path, spelling and ignore rules; this does not establish runtime absence.');
  const target = candidates[0]!;
  if (!/\.(vue|tsx|jsx|svelte|astro)$/.test(target)) throw new Error('UNSUPPORTED_PROP_SEARCH_FRAMEWORK: component prop supply search currently analyzes Vue, React/JSX, Svelte, and Astro templates only; use explicit search for this target.');
  const impact = await analyzePropImpact({ target, workspace: scope,
    props: [{ name: parsed.prop, required: false, type: 'unknown' }], detail: 'full' });
  const matches = [];
  const prop = impact.props[0]!;
  const selected = parsed.operation === 'component-prop-omissions'
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
      impact.diagnostics.push({ file: usage.file, code: 'PROP_SEARCH_SOURCE_CHANGED', reason: 'A selected render or usage changed before source retrieval; repeat the request.' });
    }
  }
  return { matches, matchCount: matches.length,
    query: { operation: parsed.operation, target, component: parsed.component, prop: parsed.prop, presence: parsed.presence, scope },
    coverage: { completeness: 'partial', diagnostics: impact.diagnostics, limitations: impact.limitations,
      propSupply: { omittedRenderCount: prop.omittedRenderCount, omittedConsumerCount: prop.omittedConsumerCount,
        indeterminateRenderCount: prop.indeterminateRenderCount, candidateUsageCount: prop.candidateUsageCount,
        boundary: 'Omissions describe static supply at resolved render sites, not runtime execution or a missing required-prop diagnosis. Candidate renders and indeterminate supply do not establish omission; counts are observed in the collected scope only.' } },
    impactIdentity: impact.inputIdentity, inputFreshness: impact.freshness };
}
