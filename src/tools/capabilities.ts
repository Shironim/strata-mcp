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
    { id: 'component-prop', source: 'src/engine/search-intent.ts', features: [feature('prop-supply', 'partial', 'Structured Vue, React/JSX, Svelte, and Astro component-prop usage and omission search (component + prop_name + prop_presence); target must be unambiguous in scope. Omission matches exclude indeterminate supply and candidate renders.')] },
    { id: 'map', source: 'src/engine/frontend-map.ts', features: [feature('file-inventory', 'partial', 'Bounded frontend path inventory; ignore rules and scope exclude files.')] },
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
      feature('imported-composable-api', 'partial', 'Direct calls to named or default local use-prefixed hooks are inspected within the selected function declaration or arrow/function initializer. Unused imports, shadowed names, module-level endpoints and other functions are excluded. Re-exports, helper call chains and dynamic invocation are not resolved; extracted endpoints do not prove runtime execution.'),
      feature('consumer-count-per-prop', 'partial', 'Opt-in impact summary/full counts explicit static Vue, React/JSX, Svelte, and Astro usages and separates candidates; scope/runtime/config closure remains incomplete.'),
    ] },
  ],
  get_component_tree: ['downward', 'upward'].map(id => ({ id, source: `src/engine/graph/${id}-traversal.ts`, features: [boundedGraph] })),
  trace_state: ['impact', 'chain'].map(id => ({ id, source: 'src/engine/storage/state-storage.ts', features: [boundedGraph,
    feature('runtime-execution', 'unsupported', 'Static state references do not prove runtime reads, writes or execution.')] })),
  audit_frontend: [
    audit('routes', 'Route conventions and statically analyzable router configuration; dynamic registrations may be missing.'),
    audit('dead-components', 'Static render/import graph candidates, not proof that components are safe to delete.'),
    audit('dead-state', 'Static unused state candidates; dynamic accesses may be unresolved.'),
    audit('api-contracts', 'Static outbound API expressions, not end-to-end backend contract verification.'),
    audit('all', 'Aggregates routes, api-contracts, dead-components and dead-state; each section retains its own limitations.'),
  ],
  generate_patch_plan: ['rename_prop', 'remove_prop', 'rename_event', 'remove_event', 'rename_model', 'remove_model', 'rename_slot', 'remove_slot']
    .map(id => ({ id, source: 'src/engine/patch-plan.ts', features: [boundedGraph,
      feature('static-consumer-edits', 'partial', 'Produces hash-bound proposals for supported static usages; rename_prop/remove_prop include Vue, Astro, JSX/TSX and Svelte consumers. Other operations retain syntax-specific limits. Validate the whole batch before applying.'),
      feature('target-declaration-forwarding-dynamic-rewrite', 'unsupported', 'Target declarations, forwarding and dynamic components are not rewritten.'),
    ] })),
};

export function selectCapabilityOperation(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case 'find_code': {
      if (args.prop_name !== undefined || args.prop !== undefined || args.propName !== undefined || args.prop_presence !== undefined || args.propPresence !== undefined) return 'component-prop';
      const path = args.path || args.file_path || args.filePath || args.target_path || args.targetPath;
      const code = args.code || args.code_snippet;
      const pattern = args.pattern || args.query || args.search;
      if (args.action === 'map') return 'map';
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

export function assessCapability(tool: string, args: Record<string, any>, observed?: Record<string, any>) {
  const path = String(args.path ?? args.file_path ?? args.filePath ?? args.component_path ?? args.componentPath ?? args.entry_path ?? args.target_path ?? '');
  const syntax = path.endsWith('.vue') ? 'vue-sfc' : path.endsWith('.svelte') ? 'svelte'
    : path.endsWith('.astro') ? 'astro' : /\.[jt]sx$/.test(path) ? 'jsx' : /\.[jt]s$/.test(path) ? 'script' : 'unknown';
  const operation = selectCapabilityOperation(tool, args);
  const entry = CAPABILITY_MANIFEST[tool]?.find(item => item.id === operation);
  const features = entry?.features.filter(item => {
    if (item.id === 'imported-composable-api') return Boolean(observed?.boundaryContracts?.some((b: any) => b.source === 'imported-composable') || observed?.resultSummary?.contract?.apiCalls?.some((b: any) => b.source === 'imported-composable'));
    if (item.id === 'consumer-count-per-prop') return args.impact !== undefined && args.impact !== 'none';
    return true;
  }).map(item => ({ ...item })) ?? [];
  return { manifestVersion: 1, tool, operation, syntax, frameworkVersion: 'unknown' as const,
    status: syntax === 'vue-sfc' && entry ? 'partial' as const : 'unknown' as const,
    implementation: entry ? 'declared' : 'unknown', validation: 'not-certified' as const,
    source: entry?.source ?? null, features,
    limitations: [
      ...(!entry ? ['No capability declaration exists for this operation.'] : []),
      'Static declaration only; framework version unknown and runtime behavior not certified.',
    ] };
}
