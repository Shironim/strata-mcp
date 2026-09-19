import { promises as fs } from 'node:fs';
import { basename, extname, normalize, resolve } from 'node:path';
import { collectFiles } from '../collector';
import { getWorkspaceDatabase } from './schema';
import { syncWorkspace } from './delta-sync';
import type {
  StateChainNode,
  StateChainResult,
  StateImpactConsumer,
  StateImpactResult,
  TraceStateChainOptions,
  UnusedStateItem,
  UnusedStateResult,
} from '../../types';

/**
 * Queries the impact of a state dependency (store, context, composable) across all files in SQLite.
 * Categorizes consumers into Mutators (triggers/actions) and Readers (renderers/watchers) via SQLite SSOT.
 */
export async function queryStateImpact(
  workspaceRoot: string,
  identifier: string,
  roleFilter: 'all' | 'mutators' | 'readers' = 'all'
): Promise<StateImpactResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  await syncWorkspace(absRoot);
  const db = getWorkspaceDatabase(absRoot);

  const rows = db
    .query(
      `
    SELECT f.path, f.is_page, f.render_boundary, s.kind, s.identifier, s.access_mode, s.line_number, s.usage_snippet
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
        usageSnippet: r.usage_snippet || undefined,
      };
      consumerMap.set(r.path, consumer);
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
      cached: true,
    },
  };
}

/**
 * Formats a StateImpactResult into a token-efficient human-readable summary.
 */
export function formatStateImpactAsText(result: StateImpactResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `State Impact Analysis for: ${result.identifier}${metaBadge}`,
    `Total Dependent Components/Pages: ${result.totalConsumers}`,
  ];

  if (result.totalConsumers === 0) {
    lines.push('\n(No dependent files found for this state identifier)');
    return lines.join('\n');
  }

  if (result.roleFilter === 'mutators') {
    lines.push(`\nMutators / Actions (Trigger / Write State) [${result.mutatorsCount || 0}]:`);
    for (const c of result.consumers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const actionBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${actionBadge}`);
    }
    return lines.join('\n');
  }

  if (result.roleFilter === 'readers') {
    lines.push(`\nReaders / Renderers (Display & Watch State) [${result.readersCount || 0}]:`);
    for (const c of result.consumers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const usageBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${usageBadge}`);
    }
    return lines.join('\n');
  }

  // Default 'all': grouped output
  if (result.mutators && result.mutators.length > 0) {
    lines.push(`\nMutators / Actions (Trigger / Write State) [${result.mutators.length}]:`);
    for (const c of result.mutators) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const actionBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${actionBadge}`);
    }
  }

  if (result.readers && result.readers.length > 0) {
    lines.push(`\nReaders / Renderers (Display & Watch State) [${result.readers.length}]:`);
    for (const c of result.readers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const usageBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${usageBadge}`);
    }
  }

  return lines.join('\n');
}

/**
 * Discovers dead or unreferenced state, composables, and stores across the workspace.
 */
export async function findUnusedState(
  workspaceRoot: string,
  options?: { scopePath?: string }
): Promise<UnusedStateResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  await syncWorkspace(absRoot, options?.scopePath);
  const db = getWorkspaceDatabase(absRoot);

  // 1. Identify all state candidate files in the workspace or scoped sub-path
  const scanTarget = options?.scopePath ? resolve(absRoot, options.scopePath) : absRoot;
  const allFiles = await collectFiles(scanTarget);
  const stateCandidates = allFiles.filter((f) => {
    const norm = f.replace(/\\/g, '/').toLowerCase();
    const ext = extname(f).toLowerCase();
    if (!['.ts', '.js', '.vue', '.tsx', '.jsx'].includes(ext)) return false;
    if (
      norm.includes('/node_modules/') ||
      norm.includes('/vendor/') ||
      norm.includes('/dist/') ||
      norm.includes('/.strata/')
    ) {
      return false;
    }
    return (
      norm.includes('/composables/') ||
      norm.includes('/hooks/') ||
      norm.includes('/stores/') ||
      norm.includes('/store/') ||
      norm.includes('/utils/state') ||
      norm.includes('/utils/composables') ||
      basename(norm).startsWith('use') ||
      basename(norm).endsWith('store.ts') ||
      basename(norm).endsWith('store.js')
    );
  });

  // 2. Extract declared identifiers (function names / store names) from each state candidate
  const declaredState: Array<{
    identifier: string;
    kind: 'store' | 'context' | 'composable';
    filePath: string;
  }> = [];

  for (const f of stateCandidates) {
    const norm = normalize(f);
    const base = basename(f, extname(f));
    try {
      const content = await fs.readFile(norm, 'utf8');
      const exportFuncMatches = content.matchAll(
        /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/g
      );
      const foundIdents = new Set<string>();
      for (const m of exportFuncMatches) {
        const ident = m[1];
        if (
          ident.startsWith('use') ||
          ident.endsWith('Store') ||
          ident.endsWith('Context') ||
          ident === base
        ) {
          foundIdents.add(ident);
        }
      }
      if (foundIdents.size === 0 && (base.startsWith('use') || base.endsWith('Store'))) {
        foundIdents.add(base);
      }

      for (const ident of foundIdents) {
        let kind: 'store' | 'context' | 'composable' = 'composable';
        if (ident.endsWith('Store') || norm.toLowerCase().includes('/stores/')) {
          kind = 'store';
        } else if (ident.endsWith('Context')) {
          kind = 'context';
        }

        declaredState.push({
          identifier: ident,
          kind,
          filePath: norm,
        });
      }
    } catch {
      // ignore
    }
  }

  // 3. For each declared state, query consumer count using SQLite state_deps
  const unusedState: UnusedStateItem[] = [];

  for (const item of declaredState) {
    const consumers = db
      .query(
        `
      SELECT DISTINCT f.path
      FROM state_deps s
      JOIN files f ON s.file_id = f.id
      WHERE s.identifier = ? AND f.path != ?;
    `
      )
      .all(item.identifier, item.filePath) as Array<{ path: string }>;

    if (consumers.length === 0) {
      unusedState.push({
        identifier: item.identifier,
        kind: item.kind,
        filePath: item.filePath,
      });
    }
  }

  // Deduplicate by filePath + identifier
  const uniqueUnused = Array.from(
    new Map(unusedState.map((u) => [`${u.filePath}::${u.identifier}`, u])).values()
  );

  const durationMs = Math.round(performance.now() - startTime);

  return {
    workspaceRoot: absRoot,
    totalScanned: declaredState.length,
    unusedCount: uniqueUnused.length,
    unusedState: uniqueUnused,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs,
      cached: true,
    },
  };
}

/**
 * Formats an UnusedStateResult into a token-efficient, human-readable summary.
 */
export function formatUnusedStateAsText(result: UnusedStateResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Unused State & Composables Audit${metaBadge}`,
    `Workspace: ${result.workspaceRoot}`,
    `Total State Declarations Scanned: ${result.totalScanned}`,
    `Unused / Orphan State Found: ${result.unusedCount}`,
  ];

  if (result.unusedCount === 0) {
    lines.push('');
    lines.push('Result: All declared composables and state stores have active consumer imports.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Dead / Orphan State (0 external consumers):');
  for (const u of result.unusedState) {
    lines.push(`  - ${u.identifier} [${u.kind}]`);
    lines.push(`    File: ${u.filePath}`);
  }

  return lines.join('\n');
}

/**
 * Traces the multi-hop dependency chain of a composable or store (both consumers and internal dependencies).
 */
export async function traceStateChain(
  workspaceRoot: string,
  options: TraceStateChainOptions
): Promise<StateChainResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  await syncWorkspace(absRoot);
  const db = getWorkspaceDatabase(absRoot);

  const identifier = options.identifier;
  const maxDepth = options.maxDepth || 3;
  const direction = options.direction || 'both';

  const consumers: StateChainNode[] = [];
  const dependencies: StateChainNode[] = [];

  // 1. Find the declaring file
  const allFiles = db.query('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;
  let declaringFile: { id: number; path: string } | undefined;

  for (const f of allFiles) {
    const base = basename(f.path, extname(f.path));
    if (base === identifier || base.toLowerCase() === identifier.toLowerCase()) {
      declaringFile = f;
      break;
    }
  }

  // 2. Consumers (Upward): Files consuming this identifier and components consuming them
  if (direction === 'consumers' || direction === 'both') {
    const visitedConsumers = new Set<string>();
    let currentFiles: Array<{ path: string; fileId: number; depth: number }> = [];

    const directRows = db
      .query(`
        SELECT DISTINCT f.id, f.path, s.kind
        FROM state_deps s
        JOIN files f ON s.file_id = f.id
        WHERE s.identifier = ?
      `)
      .all(identifier) as Array<{ id: number; path: string; kind: string }>;

    for (const row of directRows) {
      if (!visitedConsumers.has(row.path)) {
        visitedConsumers.add(row.path);
        const node: StateChainNode = {
          identifier: row.path.split(/[/\\]/).pop() || row.path,
          filePath: row.path,
          kind: row.kind as any,
          direction: 'consumer',
          depth: 1,
        };
        consumers.push(node);
        currentFiles.push({ path: row.path, fileId: row.id, depth: 1 });
      }
    }

    // Traverse upwards along edges: who imports these current files?
    for (let d = 2; d <= maxDepth && currentFiles.length > 0; d++) {
      const nextFiles: Array<{ path: string; fileId: number; depth: number }> = [];
      for (const curr of currentFiles) {
        const parentRows = db
          .query(`
            SELECT DISTINCT f.id, f.path
            FROM edges e
            JOIN files f ON e.parent_file_id = f.id
            WHERE e.child_file_id = ?
          `)
          .all(curr.fileId) as Array<{ id: number; path: string }>;

        for (const prow of parentRows) {
          if (!visitedConsumers.has(prow.path)) {
            visitedConsumers.add(prow.path);
            const node: StateChainNode = {
              identifier: prow.path.split(/[/\\]/).pop() || prow.path,
              filePath: prow.path,
              kind: prow.path.endsWith('.vue') ? 'component' : 'composable',
              direction: 'consumer',
              depth: d,
            };
            consumers.push(node);
            nextFiles.push({ path: prow.path, fileId: prow.id, depth: d });
          }
        }
      }
      currentFiles = nextFiles;
    }
  }

  // 3. Dependencies (Downward): What other composables/helpers does the declaring file consume?
  if ((direction === 'dependencies' || direction === 'both') && declaringFile) {
    const visitedDeps = new Set<string>();
    let currentDepFiles: Array<{ fileId: number; depth: number }> = [{ fileId: declaringFile.id, depth: 1 }];

    for (let d = 1; d <= maxDepth && currentDepFiles.length > 0; d++) {
      const nextDepFiles: Array<{ fileId: number; depth: number }> = [];
      for (const curr of currentDepFiles) {
        const depRows = db
          .query(`
            SELECT DISTINCT s.identifier, s.kind
            FROM state_deps s
            WHERE s.file_id = ?
          `)
          .all(curr.fileId) as Array<{ identifier: string; kind: string }>;

        for (const drow of depRows) {
          if (drow.identifier !== identifier && !visitedDeps.has(drow.identifier)) {
            visitedDeps.add(drow.identifier);

            const depFileRow = db
              .query(`
                SELECT f.id, f.path
                FROM files f
                WHERE f.path LIKE '%' || ? || '%'
                LIMIT 1
              `)
              .get(drow.identifier) as { id: number; path: string } | null;

            dependencies.push({
              identifier: drow.identifier,
              filePath: depFileRow ? depFileRow.path : '',
              kind: drow.kind as any,
              direction: 'dependency',
              depth: d,
            });

            if (depFileRow) {
              nextDepFiles.push({ fileId: depFileRow.id, depth: d + 1 });
            }
          }
        }
      }
      currentDepFiles = nextDepFiles;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    identifier,
    entryFile: declaringFile?.path,
    consumers,
    dependencies,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs,
      cached: true,
    },
  };
}

/**
 * Formats StateChainResult into readable markdown.
 */
export function formatStateChainAsText(result: StateChainResult): string {
  const lines: string[] = [];
  lines.push(`### State Dependency Chain: \`${result.identifier}\``);
  if (result.entryFile) {
    lines.push(`**Declared in:** \`${result.entryFile}\``);
  }

  lines.push('\n**Consumers (Upward Blast Radius):**');
  if (result.consumers.length > 0) {
    for (const c of result.consumers) {
      const indent = '  '.repeat(c.depth);
      lines.push(`${indent}└─ [Depth ${c.depth}] \`${c.filePath}\` (${c.kind})`);
    }
  } else {
    lines.push('  (No consumers found)');
  }

  lines.push('\n**Internal Dependencies (Downward Call Chain):**');
  if (result.dependencies.length > 0) {
    for (const d of result.dependencies) {
      const indent = '  '.repeat(d.depth);
      const fileStr = d.filePath ? ` — \`${d.filePath}\`` : '';
      lines.push(`${indent}└─ [Depth ${d.depth}] \`${d.identifier}\` (${d.kind})${fileStr}`);
    }
  } else {
    lines.push('  (No internal dependencies found)');
  }

  return lines.join('\n');
}
