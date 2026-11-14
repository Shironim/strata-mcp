import { parseSafePositiveInt, parseStringList, parseAliasMapInput } from '../engine/path-resolver';

const normalized = new WeakMap<object, string>();

const requestAliases: Record<string, string[]> = {
  code: ['code_snippet'], include_structured: ['includeStructured'],
  expected_hash: ['expectedHash'], max_regions: ['maxRegions'],
  audit_events: ['auditEvents'], outline: ['include_outline', 'outline_symbols'],
  include_pages: ['includePages'], include_props: ['includeProps'],
  response_detail: ['responseDetail'],
};

/** Additional aliases share the same boundary for direct handlers, CLI and MCP dispatch. */
export function normalizeToolRequest(tool: string, input: unknown): Record<string, any> {
  const args = coerceToolArguments(tool, input);
  for (const [canonical, aliases] of Object.entries(requestAliases)) {
    if (args[canonical] === undefined) {
      const alias = aliases.find(key => args[key] !== undefined);
      if (alias) args[canonical] = args[alias];
    }
  }
  return args;
}

export function isExactSourceRequest(tool: string, args: Record<string, unknown>): boolean {
  return tool === 'inspect_component' && (args.view === 'source' || args.source_range !== undefined || Boolean(args.sfc_sections));
}

export type InspectOperation = 'contract' | 'map' | 'source' | 'source_range' | 'sfc_sections' | 'outline' | 'symbol' | 'audit_events';
export type ImpactDetail = 'none' | 'summary' | 'full';

export function selectInspectOperation(args: Record<string, unknown>): { operation: InspectOperation; impact: ImpactDetail } {
  const impact = args.impact ?? 'none';
  if (impact !== 'none' && impact !== 'summary' && impact !== 'full') throw new Error("'impact' must be 'none', 'summary', or 'full'.");
  const view = args.view;
  if (view !== undefined && view !== 'map' && view !== 'source') throw new Error("'view' must be 'map' or 'source'.");
  const selectors: InspectOperation[] = [];
  if (view) selectors.push(view);
  if (args.symbol) selectors.push('symbol');
  if (args.outline) selectors.push('outline');
  if (args.source_range !== undefined) selectors.push('source_range');
  if (args.sfc_sections) selectors.push('sfc_sections');
  if (args.audit_events) selectors.push('audit_events');
  if (impact !== 'none' && selectors.length) throw new Error("'impact' applies only to component contract inspection; remove other selectors.");
  if (selectors.length > 1) throw new Error(view
    ? "'view' cannot be combined with symbol, outline, source_range, sfc_sections, or audit_events selectors."
    : 'Use only one of symbol, outline, source_range, sfc_sections, or audit_events per inspect request.');
  if (args.source_ref && view !== 'source') throw new Error("'source_ref' requires 'view: source'.");
  if (args.expected_hash && args.source_range === undefined) throw new Error("'expected_hash' requires 'source_range'.");
  return { operation: selectors[0] ?? 'contract', impact };
}

export function coerceToolArguments(toolName: string, rawArgs: unknown): Record<string, any> {
  if (rawArgs && typeof rawArgs === 'object' && normalized.get(rawArgs) === toolName) return rawArgs;
  if (rawArgs === null || rawArgs === undefined) {
    return {};
  }

  // Single-arity bare string handling
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    switch (toolName) {
      case 'inspect_component':
      case 'get_component_tree':
      case 'audit_frontend':
      case 'generate_patch_plan':
        return { path: trimmed };
      case 'find_code':
        return { pattern: trimmed };
      case 'trace_state':
        if (
          trimmed.startsWith('.') ||
          trimmed.startsWith('/') ||
          /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(trimmed)
        ) {
          return { path: trimmed };
        }
        return { identifier: trimmed };
      default:
        return { path: trimmed };
    }
  }

  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return {};
  }

  const args: Record<string, any> = { ...rawArgs };
  const hasSeparateScanRoot = toolName === 'get_component_tree' || toolName === 'generate_patch_plan';
  const targetAlias = args.target_path || args.targetPath;
  const legacyTargetFile = hasSeparateScanRoot && /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(targetAlias || ''));

  // 1. Canonical Entity Aliasing: path
  if (!args.path) {
    const pathAlias =
      args.file_path ||
      args.filePath ||
      (!hasSeparateScanRoot && targetAlias) ||
      args.file ||
      args.entry_path ||
      args.entryPath ||
      args.component_path ||
      args.componentPath ||
      (legacyTargetFile && targetAlias);
    if (pathAlias) {
      args.path = String(pathAlias);
    }
  }

  // Bi-directional alias sync: populate legacy targetPath/target_path/entry_path/component_path from canonical path
  if (hasSeparateScanRoot) {
    if (legacyTargetFile) {
      delete args.target_path;
      delete args.targetPath;
    } else if (targetAlias) {
      args.target_path = targetAlias;
      args.targetPath = targetAlias;
    }
  }
  if (args.path) {
    if (!hasSeparateScanRoot) {
      if (!args.targetPath) args.targetPath = args.path;
      if (!args.target_path) args.target_path = args.path;
    }
    if (!args.entry_path && toolName === 'get_component_tree' && /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(args.path))) args.entry_path = args.path;
    if (!args.component_path && toolName === 'generate_patch_plan') args.component_path = args.path;
    if (!args.filePath && toolName === 'trace_state') args.filePath = args.path;
  }

  // 2. Canonical Entity Aliasing: format
  if (!args.format) {
    const formatAlias = args.output_format || args.outputFormat;
    if (formatAlias) {
      args.format = String(formatAlias);
    }
  }
  if (!args.output_format && args.format) {
    args.output_format = args.format;
  }

  // 3. Canonical Entity Aliasing: pattern
  if (!args.pattern) {
    const patternAlias = args.query || args.search;
    if (patternAlias) {
      args.pattern = String(patternAlias);
    }
  }

  // 4. Canonical Entity Aliasing: symbol
  if (!args.symbol) {
    const symbolAlias = args.symbol_name || args.symbolName || args.name;
    if (symbolAlias && toolName !== 'audit_frontend') {
      args.symbol = String(symbolAlias);
    }
  }

  // 5. Canonical Entity Aliasing: identifier (for trace_state)
  if (!args.identifier && toolName === 'trace_state') {
    const idAlias =
      args.state ||
      args.state_name ||
      args.stateName ||
      args.store ||
      args.store_name ||
      args.storeName ||
      args.composable ||
      args.symbol ||
      args.name;
    if (idAlias) {
      args.identifier = String(idAlias);
    }
  }

  // 6. Canonical Entity Aliasing: component & prop_name / prop_presence
  if (!args.component) {
    const compAlias = args.component_name || args.componentName;
    if (compAlias) {
      args.component = String(compAlias);
    }
  }
  if (toolName === 'find_code') {
    if (args.prop_name === undefined && (args.prop !== undefined || args.propName !== undefined)) {
      args.prop_name = args.prop ?? args.propName;
    }
    if (args.prop_presence === undefined && args.propPresence !== undefined) {
      args.prop_presence = args.propPresence;
    }
  }

  // 7. Canonical Entity Aliasing: root (Pillar 4: Multi-root workspace consistency)
  if (!args.root) {
    const rootAlias =
      args.workspace_root ||
      args.workspaceRoot ||
      args.project_root ||
      args.projectRoot;
    if (rootAlias) {
      args.root = String(rootAlias);
    }
  }
  if (args.root) {
    if (!args.target_path || /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(args.target_path))) {
      args.target_path = args.root;
      args.targetPath = args.root;
    }
  }

  // 9. Canonical Entity Aliasing for generate_patch_plan
  if (toolName === 'generate_patch_plan') {
    if (!args.operations && (args.batch_operations || args.batchOperations)) {
      args.operations = args.batch_operations || args.batchOperations;
    }
    if (!args.refactor_type) {
      const refactorAlias = args.refactor || args.refactorType;
      if (refactorAlias) args.refactor_type = String(refactorAlias);
    }
    if (!args.old_name) {
      const oldAlias = args.old || args.oldName;
      if (oldAlias) args.old_name = String(oldAlias);
    }
    if (!args.new_name) {
      const newAlias = args.new || args.newName;
      if (newAlias) args.new_name = String(newAlias);
    }
  }

  // 10. Canonical Entity Aliasing: framework / framework_hint / frameworkHint
  if (!args.framework && (args.framework_hint || args.frameworkHint)) {
    args.framework = String(args.framework_hint || args.frameworkHint);
  }

  // 11. Canonical Entity Aliasing: scope_path / scope_filter / scopePath / scopeFilter
  const rawScope = args.scope_path ?? args.scopePath ?? args.scope_filter ?? args.scopeFilter;
  if (rawScope !== undefined) {
    if (args.scope_path === undefined) args.scope_path = String(rawScope);
    if (args.scope_filter === undefined) args.scope_filter = String(rawScope);
  }

  // 12. Canonical Entity Aliasing: alias_map / aliasMap / alias
  const rawAliasMap = args.alias_map ?? args.aliasMap ?? args.alias;
  if (rawAliasMap !== undefined) {
    const parsedAliasMap = parseAliasMapInput(rawAliasMap);
    if (parsedAliasMap) {
      args.alias_map = parsedAliasMap;
    } else {
      delete args.alias_map;
      delete args.aliasMap;
      delete args.alias;
    }
  }

  // 13. Canonical Entity Aliasing: exclude_dirs / excludeDirs & ignore_patterns / ignorePatterns
  const rawExcludeDirs = args.exclude_dirs ?? args.excludeDirs;
  if (rawExcludeDirs !== undefined) {
    args.exclude_dirs = parseStringList(rawExcludeDirs);
  }
  const rawIgnorePatterns = args.ignore_patterns ?? args.ignorePatterns;
  if (rawIgnorePatterns !== undefined) {
    args.ignore_patterns = parseStringList(rawIgnorePatterns);
  }

  // 14. Safe numeric parsing & depth normalization
  const parsedDepth = parseSafePositiveInt(args.depth ?? args.max_depth ?? args.maxDepth);
  if (parsedDepth !== undefined) {
    args.depth = parsedDepth;
    args.max_depth = parsedDepth;
  } else {
    delete args.depth;
    delete args.max_depth;
  }

  const rawMaxResults = args.max_results ?? args.maxResults;
  if (rawMaxResults !== undefined) {
    const parsedMaxResults = parseSafePositiveInt(rawMaxResults);
    if (parsedMaxResults !== undefined) {
      args.max_results = parsedMaxResults;
    } else {
      delete args.max_results;
    }
  }

  // 15. Context Budget & Continuation Token Normalization (R-07 / R-08)
  const rawMaxBytes = args.max_bytes !== undefined ? args.max_bytes : args.maxBytes;
  if (rawMaxBytes !== undefined) {
    // Preserve invalid budgets for the boundary validator; never silently remove a caller's limit.
    args.max_bytes = rawMaxBytes;
    args.maxBytes = rawMaxBytes;
  }

  const rawContinuationToken = args.continuation_token ?? args.continuationToken;
  if (rawContinuationToken !== undefined) {
    const trimmed = String(rawContinuationToken).trim();
    if (trimmed) {
      args.continuation_token = trimmed;
      args.continuationToken = trimmed;
    } else {
      delete args.continuation_token;
      delete args.continuationToken;
    }
  }

  normalized.set(args, toolName);
  return args;
}

