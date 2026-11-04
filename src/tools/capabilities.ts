import { normalizeAuditTarget } from '../engine/path-resolver';

export type CapabilityStatus = 'supported' | 'partial' | 'unsupported' | 'unknown';
interface CapabilityFeature { id: string; status: CapabilityStatus; reason: string }
interface CapabilityOperation { id: string; source: string; features: CapabilityFeature[] }
const feature = (id: string, status: CapabilityStatus, reason: string): CapabilityFeature => ({ id, status, reason });
const boundedGraph = feature('discovery', 'partial', 'Static resolution is bounded by scope/depth; dynamic and unresolved references require manual review.');
const exactSource = feature('source-selection', 'supported', 'Returns requested source ranges; hash validation applies when a source_ref or expected_hash is supplied.');
const audit = (id: string, reason: string): CapabilityOperation => ({ id, source: 'src/tools/audit-frontend.ts', features: [feature(id, 'partial', reason)] });

/** Declared implementation scope, not framework certification. No I/O or version inference. */
export const CAPABILITY_MANIFEST: Readonly<Record<string, readonly CapabilityOperation[]>> = {
  find_code: [
    { id: 'intent', source: 'src/engine/search-intent.ts', features: [feature('natural-language', 'partial', 'Bounded Indonesian/English component-prop usage and omission grammar for Vue; target must be unambiguous, query interpretation is returned. Omission matches exclude indeterminate supply and candidate renders. Other intents are unsupported.')] },
    { id: 'map', source: 'src/engine/frontend-map.ts', features: [feature('file-inventory', 'partial', 'Bounded frontend path inventory; ignore rules and scope exclude files.')] },
    { id: 'dump_ast', source: 'src/tools/find-code.ts', features: [feature('syntax-tree', 'partial', 'Uses the selected ast-grep language; parser acceptance is not semantic correctness.')] },
    ...['ast', 'auto', 'literal', 'yaml', 'component'].map(id => ({ id, source: 'src/engine/search.ts', features: [
      feature('matches', 'partial', id === 'literal' ? 'Exact case-sensitive substring per line, without regex or semantic interpretation.' : 'Selected structural syntax or component usages; no completeness guarantee across unsupported syntax.'),
      feature('natural-language', 'unsupported', 'Use pattern, component or rule_yaml. Arbitrary natural-language interpretation is not implemented.'),
    ] })),
  ],
  inspect_component: [
    { id: 'map', source: 'src/engine/source-map.ts', features: [feature('source-regions', 'partial', 'Region extraction is bounded by max_regions and parser capability.')] },
    ...['source', 'source_range', 'sfc_sections'].map(id => ({ id, source: 'src/tools/inspect-component.ts', features: [exactSource,
      ...(id === 'sfc_sections' ? [feature('non-vue-sections', 'unsupported', 'SFC section extraction is available only for Vue files.')] : [])] })),
    { id: 'outline', source: 'src/engine/outline.ts', features: [feature('symbols', 'partial', 'Static symbol outline and callee hints; dynamic dispatch may be unresolved.')] },
    { id: 'symbol', source: 'src/engine/slicer.ts', features: [feature('symbol-selection', 'partial', 'Named declaration selection and static caller candidates; import edges do not prove invocation.')] },
    { id: 'audit_events', source: 'src/engine/reactivity.ts', features: [feature('event-bindings', 'partial', 'Vue template/script event-binding diagnostics only; not runtime event verification.')] },
    { id: 'contract', source: 'src/engine/contract.ts', features: [
      ...['props', 'emits', 'slots', 'state'].map(id => feature(id, 'partial', 'Static extraction varies by syntax and framework; imported/dynamic definitions may remain unresolved.')),
      feature('consumer-count-per-prop', 'partial', 'Opt-in impact summary/full counts explicit static Vue script-setup usages and separates candidates; scope/runtime/config closure remains incomplete. Other target frameworks are unsupported by impact analysis.'),
      feature('contract-expectations', 'partial', 'Caller-supplied prop presence/type/requiredness checks are evaluated only for closed local Vue script-setup declarations; other definitions yield UNKNOWN. This does not verify consumer or business behavior.'),
    ] },
  ],
  get_component_tree: ['downward', 'upward'].map(id => ({ id, source: `src/engine/graph/${id}-traversal.ts`, features: [boundedGraph] })),
  trace_state: ['impact', 'chain'].map(id => ({ id, source: 'src/engine/storage/state-storage.ts', features: [boundedGraph,
    feature('runtime-execution', 'unsupported', 'Static state references do not prove runtime reads, writes or execution.')] })),
  audit_frontend: [
    audit('routes', 'Route conventions and statically analyzable router configuration; dynamic registrations may be missing.'),
    audit('dead-components', 'Static render/import graph candidates, not proof that components are safe to delete.'),
    audit('dead-state', 'Static unused state candidates; dynamic accesses may be unresolved.'),
    audit('similar-templates', 'Structural similarity candidates, not equivalent business behavior.'),
    audit('design-tokens', 'Selected design tokens and accessibility rules; not a complete browser accessibility audit.'),
    audit('bundle-health', 'Catalog-based eager import warnings, not measured bundle sizes.'),
    audit('api-contracts', 'Static outbound API expressions, not end-to-end backend contract verification.'),
    audit('archetype-drift', 'Structural comparison to an exemplar, not approved business intent.'),
    audit('all', 'Aggregates selected audits; each section retains its own limitations. Does not include archetype-drift.'),
  ],
  generate_patch_plan: ['rename_prop', 'remove_prop', 'rename_event', 'remove_event', 'rename_model', 'remove_model', 'rename_slot', 'remove_slot']
    .map(id => ({ id, source: 'src/engine/patch-plan.ts', features: [boundedGraph,
      feature('static-consumer-edits', 'partial', 'Produces hash-bound proposals for supported static usages; validate the whole batch before applying.'),
      feature('target-declaration-forwarding-dynamic-rewrite', 'unsupported', 'Target declarations, forwarding and dynamic components are not rewritten.'),
    ] })),
};

export function selectCapabilityOperation(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case 'find_code': {
      if (args.intent !== undefined) return 'intent';
      const path = args.path || args.file_path || args.filePath || args.target_path || args.targetPath;
      const code = args.code || args.code_snippet;
      const pattern = args.pattern || args.query || args.search;
      if (args.action === 'map') return 'map';
      if (args.action === 'dump_ast' || (!path && code && !pattern && !args.rule_yaml)) return 'dump_ast';
      if (code && args.rule_yaml) return 'yaml';
      if (code && pattern) return String(args.mode ?? 'ast');
      if (args.component || args.component_name || args.componentName) return 'component';
      if (args.rule_yaml) return 'yaml';
      return String(args.mode ?? 'ast');
    }
    case 'inspect_component':
      if (args.view) return String(args.view);
      if (args.source_range) return 'source_range';
      if (args.sfc_sections) return 'sfc_sections';
      if (args.outline || args.include_outline || args.outline_symbols) return 'outline';
      if (args.symbol || args.symbol_name) return 'symbol';
      if (args.audit_events || args.auditEvents) return 'audit_events';
      return 'contract';
    case 'get_component_tree': return ['up', 'upward'].includes(String(args.direction).toLowerCase()) ? 'upward' : 'downward';
    case 'trace_state': return Number(args.depth ?? args.max_depth ?? args.maxDepth ?? 1) > 1 || ['dependencies', 'both'].includes(args.direction) ? 'chain' : 'impact';
    case 'audit_frontend': return normalizeAuditTarget(args.target, 'all');
    case 'generate_patch_plan': return String(args.refactor_type ?? args.refactorType ?? args.refactor ?? 'unknown');
    default: return 'unknown';
  }
}

export function assessCapability(tool: string, args: Record<string, any>) {
  const path = String(args.path ?? args.file_path ?? args.filePath ?? args.component_path ?? args.componentPath ?? args.entry_path ?? args.target_path ?? '');
  const syntax = path.endsWith('.vue') ? 'vue-sfc' : path.endsWith('.svelte') ? 'svelte'
    : path.endsWith('.astro') ? 'astro' : /\.[jt]sx$/.test(path) ? 'jsx' : /\.[jt]s$/.test(path) ? 'script' : 'unknown';
  const operation = selectCapabilityOperation(tool, args);
  const entry = CAPABILITY_MANIFEST[tool]?.find(item => item.id === operation);
  return { manifestVersion: 1, tool, operation, syntax, frameworkVersion: 'unknown' as const,
    status: syntax === 'vue-sfc' && entry ? 'partial' as const : 'unknown' as const,
    implementation: entry ? 'declared' : 'unknown', validation: 'not-certified' as const,
    source: entry?.source ?? null, features: entry?.features.map(item => ({ ...item })) ?? [],
    limitations: [
      ...(entry?.features.filter(item => item.status !== 'supported').map(item => item.reason) ?? ['No capability declaration exists for this operation.']),
      'Framework version is unknown. Declared implementation support is not runtime verification; non-Vue capabilities are not certified by this milestone.',
    ] };
}
