import { relative, resolve } from 'node:path';
import type { StateImpactConsumer, StateImpactResult } from '../../types';
import { canonicalizePath } from '../path-resolver';
import { prepareStateQuery } from './state-query';

type StateObservation = {
  kind: FileStateDepItem['kind'];
  identifier: string;
  access_mode: FileStateDepItem['accessMode'];
  line_number: number | null;
  usage_snippet: string | null;
  accessed_properties: string | null;
};

const accessPriority = { read: 0, watch: 1, write: 2 };

/** Rows are ordered by source line, with unlocated observations last. */
function summarizeStateObservations(rows: [StateObservation, ...StateObservation[]]): FileStateDepItem {
  const first = rows[0];
  let evidence = first;
  const actions = new Set<string>();
  const properties = new Set<string>();
  for (const row of rows) {
    if (accessPriority[row.access_mode] > accessPriority[evidence.access_mode]) evidence = row;
    if (row.access_mode === 'write' && row.usage_snippet) actions.add(row.usage_snippet);
    if (row.accessed_properties) {
      try {
        const parsed: unknown = JSON.parse(row.accessed_properties);
        if (Array.isArray(parsed)) {
          for (const property of parsed) if (typeof property === 'string') properties.add(property);
        }
      } catch {
        // Older or malformed index rows may lack usable property metadata.
      }
    }
  }
  return {
    kind: first.kind,
    identifier: first.identifier,
    role: evidence.access_mode === 'write' ? 'mutator' : 'reader',
    accessMode: evidence.access_mode,
    lineNumber: evidence.line_number || undefined,
    usageSnippet: evidence.usage_snippet || undefined,
    actionsCalled: actions.size ? [...actions] : undefined,
    accessedProperties: properties.size ? [...properties] : undefined,
  };
}

/**
 * Queries the impact of a state dependency (store, context, composable) across all files in SQLite.
 * Categorizes consumers into Mutators (triggers/actions) and Readers (renderers/watchers) via SQLite SSOT.
 */
export async function queryStateImpact(
  workspaceRoot: string,
  identifier: string,
  roleFilter: 'all' | 'mutators' | 'readers' = 'all',
  options?: { skipSync?: boolean }
): Promise<StateImpactResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  const { db, sync } = await prepareStateQuery(absRoot, options?.skipSync);

  const rows = db
    .query(
      `
    SELECT f.path, f.is_page, f.render_boundary, s.kind, s.identifier, s.access_mode, s.line_number, s.usage_snippet, s.accessed_properties
    FROM state_deps s
    JOIN files f ON s.file_id = f.id
    WHERE s.identifier = ?
    ORDER BY f.is_page DESC, f.path ASC, (s.line_number > 0) DESC, s.line_number ASC, s.id ASC;
  `
    )
    .all(identifier) as Array<StateObservation & {
    path: string;
    is_page: number;
    render_boundary: string | null;
  }>;

  const byPath = new Map<string, [(typeof rows)[number], ...StateObservation[]]>();
  for (const row of rows) {
    const group = byPath.get(row.path);
    if (group) group.push(row);
    else byPath.set(row.path, [row]);
  }

  const consumers: StateImpactConsumer[] = Array.from(byPath.values(), group => ({
    ...summarizeStateObservations(group),
    path: group[0].path,
    isPage: group[0].is_page === 1,
    renderBoundary: group[0].render_boundary || undefined,
  }));

  const mutators = consumers.filter((c) => c.role === 'mutator');
  const readers = consumers.filter((c) => c.role === 'reader');

  let filteredConsumers = consumers;
  if (roleFilter === 'mutators') {
    filteredConsumers = mutators;
  } else if (roleFilter === 'readers') {
    filteredConsumers = readers;
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    identifier,
    totalConsumers: consumers.length,
    roleFilter,
    mutatorsCount: mutators.length,
    readersCount: readers.length,
    mutators,
    readers,
    consumers: filteredConsumers,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs,
      cached: sync.cacheHit,
      syncGeneration: sync.syncGeneration,
      configFingerprint: sync.configFingerprint,
    },
  };
}

export interface FileStateDepItem {
  identifier: string;
  kind: 'store' | 'context' | 'composable';
  role: 'mutator' | 'reader';
  accessMode: 'read' | 'write' | 'watch';
  lineNumber?: number;
  actionsCalled?: string[];
  accessedProperties?: string[];
  usageSnippet?: string;
}

export interface FileStateDepsResult {
  filePath: string;
  workspaceRoot: string;
  roleFilter: 'all' | 'mutators' | 'readers';
  totalDependencies: number;
  dependencies: FileStateDepItem[];
  _meta: NonNullable<StateImpactResult['_meta']>;
}

/**
 * Queries all indexed shared state dependencies (stores, contexts, composables) used by a single file.
 */
export async function queryFileStateDeps(
  workspaceRoot: string,
  filePath: string,
  roleFilter: 'all' | 'mutators' | 'readers' = 'all',
  options?: { skipSync?: boolean }
): Promise<FileStateDepsResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  const canonicalFile = canonicalizePath(filePath);
  const { db, sync } = await prepareStateQuery(absRoot, options?.skipSync);

  const rows = db
    .query(
      `
    SELECT s.kind, s.identifier, s.access_mode, s.line_number, s.usage_snippet, s.accessed_properties
    FROM state_deps s
    JOIN files f ON s.file_id = f.id
    WHERE f.path = ?
    ORDER BY s.identifier ASC, (s.line_number > 0) DESC, s.line_number ASC, s.id ASC;
  `
    )
    .all(canonicalFile) as StateObservation[];

  const byKey = new Map<string, [StateObservation, ...StateObservation[]]>();
  for (const row of rows) {
    const key = `${row.kind}:${row.identifier}`;
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  const all = Array.from(byKey.values(), summarizeStateObservations);

  const filtered =
    roleFilter === 'mutators'
      ? all.filter((d) => d.role === 'mutator')
      : roleFilter === 'readers'
      ? all.filter((d) => d.role === 'reader')
      : all;

  return {
    filePath: canonicalFile,
    workspaceRoot: absRoot,
    roleFilter,
    totalDependencies: all.length,
    dependencies: filtered,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs: Math.round(performance.now() - startTime),
      cached: sync.cacheHit,
      syncGeneration: sync.syncGeneration,
      configFingerprint: sync.configFingerprint,
    },
  };
}

export function formatFileStateDepsAsText(result: FileStateDepsResult): string {
  const relFile = relative(result.workspaceRoot, result.filePath);
  const displayFile = relFile && !relFile.startsWith('..') ? relFile : result.filePath;
  const lines = [
    `File State Dependencies for: ${displayFile} [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms | Graph generation ${result._meta.syncGeneration ?? 'n/a'}${result._meta.cached ? ' | cache hit' : ''}]`,
    `Total Indexed State Dependencies: ${result.totalDependencies}`,
  ];

  if (result.dependencies.length === 0) {
    lines.push('', '(No indexed store, context, or composable dependencies found in this file)');
    return lines.join('\n');
  }

  lines.push('');
  for (const dep of result.dependencies) {
    const loc = dep.lineNumber ? ` (L${dep.lineNumber})` : '';
    const props = dep.accessedProperties?.length ? ` | props: ${dep.accessedProperties.join(', ')}` : '';
    const actions = dep.actionsCalled?.length ? ` | actions: ${dep.actionsCalled.join(', ')}` : '';
    lines.push(`- ${dep.identifier} [${dep.kind}; ${dep.role}/${dep.accessMode}]${loc}${props}${actions}`);
  }
  return lines.join('\n');
}
