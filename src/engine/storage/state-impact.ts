import { relative, resolve } from 'node:path';
import type { StateImpactConsumer, StateImpactResult } from '../../types';
import { canonicalizePath } from '../path-resolver';
import { prepareStateQuery } from './state-query';

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
    ORDER BY f.is_page DESC, f.path ASC;
  `
    )
    .all(identifier) as Array<{
    path: string;
    is_page: number;
    render_boundary: string | null;
    kind: 'store' | 'context' | 'composable';
    identifier: string;
    access_mode: 'read' | 'write' | 'watch';
    line_number: number;
    usage_snippet: string | null;
    accessed_properties: string | null;
  }>;

  // Aggregate rows by consumer path so that a file with write actions is classified as mutator
  const consumerMap = new Map<string, StateImpactConsumer>();

  for (const r of rows) {
    let consumer = consumerMap.get(r.path);
    if (!consumer) {
      consumer = {
        path: r.path,
        isPage: r.is_page === 1,
        renderBoundary: r.render_boundary || undefined,
        kind: r.kind,
        identifier: r.identifier,
        role: 'reader',
        accessMode: r.access_mode,
        lineNumber: r.line_number || undefined,
        actionsCalled: [],
        accessedProperties: [],
        usageSnippet: r.usage_snippet || undefined,
      };
      consumerMap.set(r.path, consumer);
    }

    if (r.accessed_properties) {
      try {
        const parsed = JSON.parse(r.accessed_properties);
        if (Array.isArray(parsed)) {
          consumer.accessedProperties = Array.from(new Set([...(consumer.accessedProperties || []), ...parsed]));
        }
      } catch {}
    }

    if (r.access_mode === 'write') {
      consumer.role = 'mutator';
      consumer.accessMode = 'write';
      if (r.usage_snippet) {
        consumer.usageSnippet = r.usage_snippet;
        if (!consumer.actionsCalled) consumer.actionsCalled = [];
        consumer.actionsCalled.push(r.usage_snippet);
      }
      if (r.line_number) {
        consumer.lineNumber = r.line_number;
      }
    } else if (consumer.role !== 'mutator') {
      if (r.access_mode === 'watch') {
        consumer.accessMode = 'watch';
      }
      if (!consumer.usageSnippet && r.usage_snippet) {
        consumer.usageSnippet = r.usage_snippet;
      }
      if (!consumer.lineNumber && r.line_number) {
        consumer.lineNumber = r.line_number;
      }
    }
  }

  const consumers = Array.from(consumerMap.values());
  for (const c of consumers) {
    if (c.actionsCalled && c.actionsCalled.length > 0) {
      c.actionsCalled = Array.from(new Set(c.actionsCalled));
    } else {
      c.actionsCalled = undefined;
    }
    if (c.accessedProperties && c.accessedProperties.length > 0) {
      c.accessedProperties = Array.from(new Set(c.accessedProperties));
    } else {
      c.accessedProperties = undefined;
    }
  }

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
    ORDER BY s.identifier ASC, s.line_number ASC;
  `
    )
    .all(canonicalFile) as Array<{
    kind: 'store' | 'context' | 'composable';
    identifier: string;
    access_mode: 'read' | 'write' | 'watch';
    line_number: number;
    usage_snippet: string | null;
    accessed_properties: string | null;
  }>;

  const byKey = new Map<string, FileStateDepItem>();
  for (const r of rows) {
    const key = `${r.kind}:${r.identifier}`;
    let item = byKey.get(key);
    if (!item) {
      item = {
        identifier: r.identifier,
        kind: r.kind,
        role: 'reader',
        accessMode: r.access_mode,
        lineNumber: r.line_number || undefined,
        actionsCalled: [],
        accessedProperties: [],
        usageSnippet: r.usage_snippet || undefined,
      };
      byKey.set(key, item);
    }

    if (r.accessed_properties) {
      try {
        const parsed = JSON.parse(r.accessed_properties);
        if (Array.isArray(parsed)) {
          item.accessedProperties = Array.from(new Set([...(item.accessedProperties || []), ...parsed]));
        }
      } catch {}
    }

    if (r.access_mode === 'write') {
      item.role = 'mutator';
      item.accessMode = 'write';
      if (r.usage_snippet) {
        item.usageSnippet = r.usage_snippet;
        item.actionsCalled!.push(r.usage_snippet);
      }
      if (!item.lineNumber && r.line_number) item.lineNumber = r.line_number;
    } else if (item.role !== 'mutator') {
      if (r.access_mode === 'watch') item.accessMode = 'watch';
      if (!item.usageSnippet && r.usage_snippet) item.usageSnippet = r.usage_snippet;
      if (!item.lineNumber && r.line_number) item.lineNumber = r.line_number;
    }
  }

  const all = Array.from(byKey.values()).map((item) => ({
    ...item,
    actionsCalled: item.actionsCalled?.length ? Array.from(new Set(item.actionsCalled)) : undefined,
    accessedProperties: item.accessedProperties?.length ? Array.from(new Set(item.accessedProperties)) : undefined,
  }));

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
