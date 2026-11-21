import { expect, test } from 'bun:test';
import { assessCapability, CAPABILITY_MANIFEST, selectCapabilityOperation } from '../../src/tools/capabilities';
import { withDecisionResponse } from '../../src/tools/decision-response';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import type { RetrievalEvidence } from '../../src/types';

function decide(tool: string, args: Record<string, unknown>, data: Record<string, unknown>, complete = false) {
  const retrieval = { scope: '/fixture', freshness: complete ? 'current' : 'unavailable', completeness: complete ? 'complete' : 'partial', omissions: [] } as unknown as RetrievalEvidence;
  return withDecisionResponse({ content: [{ type: 'text', text: 'primary' }], structuredContent: { ...data, retrieval } }, tool, args).structuredContent?.decision as any;
}

test('manifest declares every audit target and patch operation in the public catalog', () => {
  for (const [tool, selector] of [['audit_frontend', 'target'], ['generate_patch_plan', 'refactor_type']]) {
    const schema = TOOL_CATALOG.find(item => item.name === tool)!.inputSchema.properties as any;
    expect(CAPABILITY_MANIFEST[tool!]!.map(item => item.id).sort()).toEqual([...schema[selector!].enum].sort());
  }
  const search = TOOL_CATALOG.find(item => item.name === 'find_code')!.inputSchema.properties as any;
  const inspect = TOOL_CATALOG.find(item => item.name === 'inspect_component')!.inputSchema.properties as any;
  for (const operation of [...search.mode.enum, 'map', 'component', 'component-prop', 'yaml'])
    expect(CAPABILITY_MANIFEST.find_code!.some(item => item.id === operation)).toBe(true);
  for (const operation of inspect.view.enum)
    expect(CAPABILITY_MANIFEST.inspect_component!.some(item => item.id === operation)).toBe(true);
});

test('capability identifies actual selectors and aliases instead of treating view as audit operation', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['find_code', { component_name: 'Child' }, 'component'],
    ['find_code', { component: 'Child', prop_name: 'title' }, 'component-prop'],
    ['find_code', { code: 'x', pattern: 'x', mode: 'literal', component: 'Ignored' }, 'literal'],
    ['inspect_component', { source_range: { start_line: 1, end_line: 1 } }, 'source_range'],
    ['inspect_component', { outline_symbols: true }, 'outline'],
    ['inspect_component', { audit_events: true }, 'audit_events'],
    ['get_component_tree', { direction: 'UP' }, 'upward'],
    ['trace_state', { max_depth: 2 }, 'chain'],
    ['trace_state', { direction: 'dependencies' }, 'chain'],
    ['audit_frontend', { target: 'dead_state', view: 'summary' }, 'dead-state'],
    ['generate_patch_plan', { refactorType: 'remove_slot' }, 'remove_slot'],
  ];
  for (const [tool, args, expected] of cases) expect(selectCapabilityOperation(tool, args)).toBe(expected);
});

test('declared implementation and framework certification remain separate', () => {
  const assessment = assessCapability('inspect_component', { path: 'Button.vue', impact: 'full' });
  expect(assessment).toMatchObject({ operation: 'contract', implementation: 'declared', validation: 'not-certified', frameworkVersion: 'unknown', status: 'partial' });
  expect(assessment.features.find(item => item.id === 'consumer-count-per-prop')?.status).toBe('partial');
  expect(assessCapability('inspect_component', { path: 'Button.svelte' }).status).toBe('unknown');
  expect(assessCapability('audit_frontend', { target: 'not-real' })).toMatchObject({ implementation: 'unknown', status: 'unknown', features: [] });
  assessment.features[0]!.status = 'unsupported';
  expect(assessCapability('inspect_component', { path: 'Button.vue' }).features[0]?.status).toBe('partial');
});

test('empty results on all six tools name only the selection they actually count', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ['find_code', { action: 'map' }, { files: [] }, 'inventory-files'],
    ['inspect_component', { symbol: 'missing' }, { found: false }, 'selected-symbol'],
    ['get_component_tree', { direction: 'upward' }, { root: { children: [] } }, 'direct-consumer-candidates'],
    ['trace_state', {}, { consumers: [], readers: [{ path: 'ignored' }] }, 'state-consumers'],
    ['audit_frontend', { target: 'routes' }, { routes: [] }, 'audit-routes'],
    ['generate_patch_plan', {}, { patches: [] }, 'proposed-static-edits'],
  ];
  for (const [tool, args, data, subject] of cases) {
    expect(decide(tool, args, data)).toMatchObject({ status: 'partial', emptyOutcome: 'inconclusive', selection: { subject, count: 0 } });
  }
});

test('missing payloads, unrelated arrays, and a missing audit section never mean empty', () => {
  expect(decide('inspect_component', {}, { props: [], slots: [] }).selection.count).toBeNull();
  expect(decide('get_component_tree', {}, { diagnostics: [] }).emptyOutcome).toBe('not-asserted');
  expect(decide('audit_frontend', { target: 'all' }, { routes: { routes: [] } }).selection.count).toBeNull();
  expect(decide('trace_state', { depth: 2 }, { consumers: [] }).selection.count).toBeNull();
});

test('filters and multiple selected collections do not manufacture absence', () => {
  expect(decide('trace_state', { direction: 'both' }, { consumers: [], dependencies: [{ identifier: 'useOther' }] }).selection.count).toBe(1);
  expect(decide('trace_state', { direction: 'consumers', depth: 2 }, { consumers: [], dependencies: [{ identifier: 'useOther' }] }).selection.count).toBe(0);
  expect(decide('audit_frontend', { target: 'all' }, { routes: { routes: [] }, unusedComponents: { unusedComponents: [] }, unusedState: { unusedState: [] }, apiContracts: { endpoints: [{ endpoint: '/api/items' }] } }).selection.count).toBe(1);
});

test('local diagnostics and coverage gaps prevent a negative complete result', () => {
  const data = { patches: [], coverage: { failedCount: 1, omissions: [] } };
  expect(decide('generate_patch_plan', {}, data, true)).toMatchObject({ status: 'partial', emptyOutcome: 'inconclusive' });
  expect(decide('get_component_tree', {}, { root: { children: [] }, diagnostics: [{ code: 'MAX_DEPTH_REACHED' }] }, true).emptyOutcome).toBe('inconclusive');
  expect(decide('find_code', {}, { matches: [] }, true).emptyOutcome).toBe('none-in-checked-scope');
  const missingScope = withDecisionResponse({ content: [], structuredContent: { matches: [], retrieval: { freshness: 'current', completeness: 'complete', omissions: [] } } }, 'find_code', {}).structuredContent?.decision as any;
  expect(missingScope).toMatchObject({ status: 'partial', emptyOutcome: 'inconclusive' });
});

test('audit all requires all selected sections and counts findings rather than empty diagnostics', () => {
  const all = { routes: { routes: [] }, unusedComponents: { unusedComponents: [] }, unusedState: { unusedState: [] },
    designSystemAudit: { arbitraryTokens: [], a11yViolations: [] }, bundleAudit: { heavyEagerImports: [] }, apiContracts: { endpoints: [] } };
  expect(decide('audit_frontend', { target: 'all' }, all).selection.count).toBe(0);
  expect(decide('audit_frontend', { target: 'all' }, { ...all, apiContracts: {} }).selection.count).toBeNull();
});

test('capabilities describe JSX impact/search and Svelte prop edits without framework certification', () => {
  const impact = assessCapability('inspect_component', { path: 'Button.tsx', impact: 'full' });
  expect(impact.features.find(f => f.id === 'consumer-count-per-prop')?.reason).toContain('React/JSX');
  expect(impact.validation).toBe('not-certified');
  expect(assessCapability('find_code', { prop_name: 'title' }).features[0]?.reason).toContain('React/JSX');
  expect(assessCapability('generate_patch_plan', { refactor_type: 'rename_prop' }).features.find(f => f.id === 'static-consumer-edits')?.reason).toContain('Svelte');
});
