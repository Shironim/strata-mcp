import { selectCapabilityOperation } from './capabilities';

export interface ResultSelection {
  subject: string;
  count: number | null;
  collections: string[];
  boundary: string;
}

const auditCollections: Record<string, string[]> = {
  routes: ['routes'], 'dead-components': ['unusedComponents'], 'dead-state': ['unusedState'],
  'similar-templates': ['clusters'], 'design-tokens': ['arbitraryTokens', 'a11yViolations'],
  'bundle-health': ['heavyEagerImports'], 'api-contracts': ['endpoints'], 'archetype-drift': ['violations'],
  all: ['routes.routes', 'unusedComponents.unusedComponents', 'unusedState.unusedState',
    'similarTemplates.clusters', 'designSystemAudit.arbitraryTokens', 'designSystemAudit.a11yViolations',
    'bundleAudit.heavyEagerImports', 'apiContracts.endpoints'],
};

/** Only explicit primary payloads establish a count. Missing data is never treated as []. */
export function describeResultSelection(tool: string, args: Record<string, any>, data: Record<string, unknown>): ResultSelection {
  const summary = data.resultSummary as { version?: number; tool?: string; selection?: ResultSelection } | undefined;
  if (summary?.version === 1 && summary.tool === tool && summary.selection) return summary.selection;
  const operation = selectCapabilityOperation(tool, args);
  let subject = 'unclassified-result';
  let collections: string[] = [];
  let boundary = 'Only the selected payload is counted; this does not establish workspace-wide absence.';
  switch (tool) {
    case 'find_code':
      subject = operation === 'map' ? 'inventory-files' : 'search-matches';
      collections = operation === 'map' ? ['files'] : operation === 'dump_ast' ? [] : ['matches'];
      break;
    case 'inspect_component':
      subject = operation === 'symbol' ? 'selected-symbol' : `component-${operation}`;
      collections = operation === 'map' ? ['regions'] : operation === 'sfc_sections' ? ['blocks'] : operation === 'outline' ? ['functions'] : [];
      if (operation === 'symbol' && data.found === false) return { subject, count: 0, collections: [], boundary: 'The requested symbol was not returned; this does not prove no callers or runtime uses exist.' };
      break;
    case 'get_component_tree':
      subject = operation === 'upward' ? 'direct-consumer-candidates' : 'direct-dependencies';
      collections = ['root.children'];
      boundary = 'Counts only immediate root neighbors, including import-only relations when returned, not all rendered, transitive or runtime consumers.';
      break;
    case 'trace_state':
      subject = operation === 'chain' ? 'state-chain-neighbors' : 'state-consumers';
      collections = operation === 'impact' ? ['consumers'] : args.direction === 'dependencies' ? ['dependencies']
        : args.direction === 'consumers' ? ['consumers'] : ['consumers', 'dependencies'];
      boundary = 'Counts selected state references after role/direction/depth filters; excluded roles and dynamic accesses are outside this count.';
      break;
    case 'audit_frontend':
      subject = `audit-${operation}`;
      collections = auditCollections[operation] ?? [];
      boundary = 'Counts findings of the selected audit only, not all application defects or unsupported audit capabilities.';
      break;
    case 'generate_patch_plan':
      subject = 'proposed-static-edits';
      collections = ['patches'];
      boundary = 'Counts proposed edits, not consumers. Zero proposals does not establish no affected usages.';
      break;
  }
  const selected = collections.map(path => path.split('.').reduce<unknown>((value, key) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, data));
  const count = selected.length > 0 && selected.every(Array.isArray)
    ? selected.reduce<number>((sum, value) => sum + (value as unknown[]).length, 0) : null;
  return { subject, count, collections, boundary };
}
