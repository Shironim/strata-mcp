import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalizePath } from '../path-resolver';
import {
  paginateItems,
  type DiagnosticRecord,
  type OmissionRecord,
  type QueryEnvelope,
  type ServiceRuntimeOptions,
  type VerificationTier,
} from './contracts';
import { NotFoundError, ValidationError } from './errors';
import { defaultSyncCoordinator } from './sync-coordinator';
import { defaultWarmDbPool } from './schema-v3';
import { defaultSemanticPool } from './semantic';
import {
  formatSourceRef,
  resolvePathWithinWorkspace,
  shortHash,
  shortHashFromFull,
} from './source-ref';

export type GraphQueryKind =
  | 'definition'
  | 'references'
  | 'callHierarchy'
  | 'componentTree'
  | 'stateFlow'
  | 'impact';

export type GraphDirection = 'up' | 'down' | 'both';
export type GraphGroupBy = 'package' | 'file' | 'none';

export interface GraphQueryTarget {
  symbolId?: string;
  file?: string;
  symbol?: string;
  member?: string;
  line?: number;
  column?: number;
}

export interface GraphQueryRequest extends ServiceRuntimeOptions {
  workspaceRoot: string;
  query: GraphQueryKind;
  target: GraphQueryTarget;
  direction?: GraphDirection;
  scope?: {
    packages?: string[];
    maxDepth?: number;
  };
  groupBy?: GraphGroupBy;
  limit?: number;
  cursor?: string;
}

export interface GraphLocationItem {
  packageKey: string;
  filePath: string;
  relPath: string;
  line: number;
  column: number;
  kind: string;
  snippet: string;
  sourceRef: string;
  isDefinition?: boolean;
  isWriteAccess?: boolean;
}

export interface ComponentTreeNodeItem {
  packageKey: string;
  filePath: string;
  relPath: string;
  componentName: string;
  depth: number;
  isPage: boolean;
  children: ComponentTreeNodeItem[];
}

export interface PackageGroupSummary {
  packageKey: string;
  count: number;
  fileCount: number;
}

export interface GraphQueryData {
  query: GraphQueryKind;
  targetSummary: string;
  items?: GraphLocationItem[];
  summaryByPackage?: PackageGroupSummary[];
  tree?: ComponentTreeNodeItem;
}

const VALID_QUERIES = new Set<GraphQueryKind>([
  'definition',
  'references',
  'callHierarchy',
  'componentTree',
  'stateFlow',
  'impact',
]);

interface ResolvedTarget {
  fileId: number;
  filePath: string;
  packageKey: string;
  symbolName: string;
  symbolKind: string;
  offset: number;
}

function lineSnippet(raw: string, line1Based: number): string {
  const lines = raw.split('\n');
  return (lines[line1Based - 1] ?? '').trim().slice(0, 140);
}

function resolveTarget(
  db: Database,
  absRoot: string,
  target: GraphQueryTarget
): ResolvedTarget {
  if (target.symbolId) {
    const row = db
      .query(
        `SELECT f.id AS file_id, f.path AS file_path, p.package_key,
                s.name, s.kind, s.start_offset
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         JOIN packages p ON p.id = f.package_id
         WHERE s.symbol_uid = ?`
      )
      .get(target.symbolId) as {
      file_id: number;
      file_path: string;
      package_key: string;
      name: string;
      kind: string;
      start_offset: number;
    } | null;
    if (!row) throw new NotFoundError(`Symbol not found: "${target.symbolId}"`);
    return {
      fileId: row.file_id,
      filePath: row.file_path,
      packageKey: row.package_key,
      symbolName: row.name,
      symbolKind: row.kind,
      offset: row.start_offset,
    };
  }

  if (target.file) {
    const absFile = resolvePathWithinWorkspace(absRoot, target.file);
    const fileRow = db
      .query(
        `SELECT f.id AS file_id, f.path AS file_path, p.package_key
         FROM files f
         JOIN packages p ON p.id = f.package_id
         WHERE f.path = ?`
      )
      .get(absFile) as { file_id: number; file_path: string; package_key: string } | null;
    if (!fileRow) throw new NotFoundError(`Indexed file not found: "${absFile}"`);

    if (target.line !== undefined) {
      const raw = readFileSync(absFile, 'utf8');
      const lines = raw.split('\n');
      let offset = 0;
      for (let i = 0; i < Math.max(0, target.line - 1) && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      offset += Math.max(0, (target.column ?? 1) - 1);
      return {
        fileId: fileRow.file_id,
        filePath: fileRow.file_path,
        packageKey: fileRow.package_key,
        symbolName: target.symbol ?? target.member ?? `line:${target.line}`,
        symbolKind: 'position',
        offset,
      };
    }

    if (target.symbol) {
      const symRow = db
        .query(
          `SELECT name, kind, start_offset FROM symbols
           WHERE file_id = ? AND name = ?
           ORDER BY start_offset ASC LIMIT 1`
        )
        .get(fileRow.file_id, target.symbol) as {
        name: string;
        kind: string;
        start_offset: number;
      } | null;
      if (!symRow) {
        throw new NotFoundError(`Symbol "${target.symbol}" not found in "${absFile}"`);
      }
      const raw = readFileSync(absFile, 'utf8');
      const nameIdx = raw.indexOf(symRow.name, symRow.start_offset);
      return {
        fileId: fileRow.file_id,
        filePath: fileRow.file_path,
        packageKey: fileRow.package_key,
        symbolName: symRow.name,
        symbolKind: symRow.kind,
        offset: nameIdx >= 0 ? nameIdx : symRow.start_offset,
      };
    }

    // Default to primary component/exported symbol in the file
    const primary = db
      .query(
        `SELECT name, kind, start_offset FROM symbols
         WHERE file_id = ?
         ORDER BY CASE kind WHEN 'component' THEN 0 ELSE 1 END, is_default DESC, start_offset ASC
         LIMIT 1`
      )
      .get(fileRow.file_id) as { name: string; kind: string; start_offset: number } | null;

    return {
      fileId: fileRow.file_id,
      filePath: fileRow.file_path,
      packageKey: fileRow.package_key,
      symbolName: primary?.name ?? absFile,
      symbolKind: primary?.kind ?? 'file',
      offset: primary?.start_offset ?? 0,
    };
  }

  if (target.symbol) {
    const symRow = db
      .query(
        `SELECT f.id AS file_id, f.path AS file_path, p.package_key,
                s.name, s.kind, s.start_offset
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         JOIN packages p ON p.id = f.package_id
         WHERE s.name = ?
         ORDER BY s.is_exported DESC, s.id ASC
         LIMIT 1`
      )
      .get(target.symbol) as {
      file_id: number;
      file_path: string;
      package_key: string;
      name: string;
      kind: string;
      start_offset: number;
    } | null;
    if (!symRow) throw new NotFoundError(`Symbol not found in workspace: "${target.symbol}"`);
    const raw = readFileSync(symRow.file_path, 'utf8');
    const nameIdx = raw.indexOf(symRow.name, symRow.start_offset);
    return {
      fileId: symRow.file_id,
      filePath: symRow.file_path,
      packageKey: symRow.package_key,
      symbolName: symRow.name,
      symbolKind: symRow.kind,
      offset: nameIdx >= 0 ? nameIdx : symRow.start_offset,
    };
  }

  throw new ValidationError('target must specify at least one of: symbolId, file, or symbol.');
}

function summarizeByPackage<T extends { packageKey: string; filePath: string }>(
  items: readonly T[]
): PackageGroupSummary[] {
  const counts = new Map<string, { count: number; files: Set<string> }>();
  for (const item of items) {
    const entry = counts.get(item.packageKey) ?? { count: 0, files: new Set<string>() };
    entry.count++;
    entry.files.add(item.filePath);
    counts.set(item.packageKey, entry);
  }
  return [...counts.entries()]
    .map(([packageKey, info]) => ({
      packageKey,
      count: info.count,
      fileCount: info.files.size,
    }))
    .sort((a, b) => b.count - a.count || a.packageKey.localeCompare(b.packageKey));
}

function findCandidatePackagesForTarget(
  db: Database,
  target: ResolvedTarget,
  explicitPackages?: string[]
): string[] {
  if (explicitPackages?.length) return explicitPackages;

  const pkgSet = new Set<string>([target.packageKey]);

  // Direct reverse file importers + barrel re-exporters (up to 2 hops)
  const rows = db
    .query(
      `WITH RECURSIVE upstream(file_id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT e.source_file_id, u.depth + 1
         FROM symbol_edges e
         JOIN upstream u ON e.target_file_id = u.file_id
         WHERE u.depth < 3 AND e.edge_kind IN ('imports', 'reexports', 'renders', 'calls')
       )
       SELECT DISTINCT p.package_key
       FROM upstream u
       JOIN files f ON f.id = u.file_id
       JOIN packages p ON p.id = f.package_id`
    )
    .all(target.fileId) as Array<{ package_key: string }>;

  for (const r of rows) pkgSet.add(r.package_key);
  return [...pkgSet].sort();
}

interface RawLocationDescriptor {
  packageKey: string;
  filePath: string;
  relPath?: string;
  contentHash?: string;
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
  kind: string;
  isDefinition?: boolean;
  isWriteAccess?: boolean;
}

interface CachedLocationFileInfo {
  packageKey: string;
  relPath: string;
  lines: string[];
  hash8: string;
}

interface FileMetaRow {
  packageKey: string;
  relPath: string;
  contentHash?: string;
}

function createLocationItemBuilder(db: Database) {
  const fileMetaStmt = db.prepare(
    `SELECT f.rel_path, f.content_hash, p.package_key
     FROM files f
     JOIN packages p ON p.id = f.package_id
     WHERE f.path = ?`
  );
  const metaCache = new Map<string, FileMetaRow>();
  const fileCache = new Map<string, CachedLocationFileInfo>();

  const getFileMeta = (filePath: string): FileMetaRow => {
    let meta = metaCache.get(filePath);
    if (!meta) {
      const row = fileMetaStmt.get(filePath) as
        | { rel_path: string; content_hash: string | null; package_key: string }
        | null;
      meta = {
        packageKey: row?.package_key ?? '.',
        relPath: row?.rel_path ?? filePath,
        contentHash: row?.content_hash ?? undefined,
      };
      metaCache.set(filePath, meta);
    }
    return meta;
  };

  const toLocationItem = (
    filePath: string,
    line: number,
    column: number,
    startOffset: number,
    endOffset: number,
    kind: string,
    extra?: {
      isDefinition?: boolean;
      isWriteAccess?: boolean;
      packageKey?: string;
      relPath?: string;
      contentHash?: string;
    }
  ): GraphLocationItem => {
    let cached = fileCache.get(filePath);
    if (!cached) {
      const meta =
        extra?.packageKey !== undefined && extra?.relPath !== undefined
          ? {
              packageKey: extra.packageKey,
              relPath: extra.relPath,
              contentHash: extra.contentHash,
            }
          : getFileMeta(filePath);
      const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      cached = {
        packageKey: meta.packageKey,
        relPath: meta.relPath,
        lines: raw ? raw.split('\n') : [],
        hash8: meta.contentHash ? shortHashFromFull(meta.contentHash) : shortHash(raw),
      };
      fileCache.set(filePath, cached);
    }
    const snippet =
      cached.lines.length > 0 ? (cached.lines[Math.max(0, line - 1)] ?? '').trim().slice(0, 140) : '';
    const result: GraphLocationItem = {
      packageKey: cached.packageKey,
      filePath,
      relPath: cached.relPath,
      line,
      column,
      kind,
      snippet,
      sourceRef: formatSourceRef(filePath, cached.hash8, startOffset, endOffset),
    };
    if (extra?.isDefinition !== undefined) result.isDefinition = extra.isDefinition;
    if (extra?.isWriteAccess !== undefined) result.isWriteAccess = extra.isWriteAccess;
    return result;
  };

  const buildFromDescriptor = (d: RawLocationDescriptor): GraphLocationItem =>
    toLocationItem(d.filePath, d.line, d.column, d.startOffset, d.endOffset, d.kind, {
      isDefinition: d.isDefinition,
      isWriteAccess: d.isWriteAccess,
      packageKey: d.packageKey,
      relPath: d.relPath,
      contentHash: d.contentHash,
    });

  return { getFileMeta, toLocationItem, buildFromDescriptor };
}

/**
 * Unified Graph Query Service:
 * Answers definition, references, callHierarchy, componentTree, stateFlow, and impact
 * using SQLite candidate filtering, TypeScript Language Service verification, and package-grouped summaries.
 */
export async function queryGraph(
  request: GraphQueryRequest
): Promise<QueryEnvelope<GraphQueryData>> {
  if (!VALID_QUERIES.has(request.query)) {
    throw new ValidationError(
      `Invalid graph query "${String(request.query)}". Expected one of: definition, references, callHierarchy, componentTree, stateFlow, impact.`
    );
  }

  const absRoot = canonicalizePath(request.workspaceRoot);
  const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });
  if (!request.skipSync) {
    await defaultSyncCoordinator.ensureSynced(absRoot, { db });
  }

  const semanticPool = request.semanticPool ?? defaultSemanticPool;
  const { getFileMeta, toLocationItem, buildFromDescriptor } = createLocationItemBuilder(db);
  const limit = request.limit ?? 30;
  const omissions: OmissionRecord[] = [];
  const diagnostics: DiagnosticRecord[] = [];

  // Special case: stateFlow can query by state identifier name directly even without file
  if (request.query === 'stateFlow') {
    const stateName = request.target.symbol ?? request.target.member;
    if (!stateName) {
      throw new ValidationError('stateFlow requires target.symbol (e.g. "useOrderStore").');
    }

    const scopePkgs = request.scope?.packages;
    const stateEdgeQuery = db.query(
      `SELECT f.path AS file_path, f.rel_path, f.content_hash, p.package_key,
              e.edge_kind, e.line_number, e.start_offset, e.end_offset
       FROM symbol_edges e
       JOIN files f ON f.id = e.source_file_id
       JOIN packages p ON p.id = f.package_id
       WHERE e.target_name = ?
         AND e.edge_kind IN ('reads_state', 'writes_state', 'watches_state', 'calls', 'provides_context', 'consumes_context')
       ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
    );
    type StateEdgeRow = {
      file_path: string;
      rel_path: string;
      content_hash: string;
      package_key: string;
      edge_kind: string;
      line_number: number;
      start_offset: number;
      end_offset: number;
    };

    let resolvedStateKey = stateName;
    let rows = stateEdgeQuery.all(stateName) as StateEdgeRow[];

    if (rows.length === 0) {
      const aliasRow = db
        .query(
          `SELECT e.target_name AS state_key
           FROM symbol_edges e
           JOIN files f ON f.id = e.source_file_id
           WHERE e.edge_kind IN ('reads_state', 'writes_state')
             AND json_extract(e.payload_json, '$.stateVar') = ?
             AND (? IS NULL OR f.path = ?)
           LIMIT 1`
        )
        .get(
          stateName,
          request.target.file ? resolvePathWithinWorkspace(absRoot, request.target.file) : null,
          request.target.file ? resolvePathWithinWorkspace(absRoot, request.target.file) : null
        ) as { state_key: string } | null;

      if (aliasRow?.state_key) {
        resolvedStateKey = aliasRow.state_key;
        rows = stateEdgeQuery.all(resolvedStateKey) as StateEdgeRow[];
      }
    }

    const filtered = scopePkgs?.length
      ? rows.filter((r) => scopePkgs.includes(r.package_key))
      : rows;

    const descriptors: RawLocationDescriptor[] = filtered.map((r) => ({
      packageKey: r.package_key,
      filePath: r.file_path,
      relPath: r.rel_path,
      contentHash: r.content_hash,
      line: r.line_number,
      column: 1,
      startOffset: r.start_offset,
      endOffset: r.end_offset,
      kind: r.edge_kind,
      isWriteAccess: r.edge_kind === 'writes_state',
    }));
    if (descriptors.length === 0) {
      diagnostics.push({
        code: 'STATE_FLOW_NO_MATCHES',
        message: `No indexed state reads, writes, context providers/consumers, or store calls found for "${stateName}". Static stateFlow tracks Pinia stores (use*Store), Nuxt useState(), React Context (createContext/Provider/useContext), and Vue provide/inject.`,
      });
    }
    const { page, pagination } = paginateItems(descriptors, limit, request.cursor);

    return {
      scope: absRoot,
      verification: 'graph',
      data: {
        query: 'stateFlow',
        targetSummary:
          resolvedStateKey !== stateName
            ? `state:${stateName} -> key:${resolvedStateKey}`
            : `state:${stateName}`,
        items: page.map(buildFromDescriptor),
        summaryByPackage: summarizeByPackage(descriptors),
      },
      pagination,
      omissions,
      diagnostics,
    };
  }

  const resolved = resolveTarget(db, absRoot, request.target);

  if (request.query === 'definition') {
    const defs = semanticPool.getDefinitionsAtOffset(absRoot, resolved.filePath, resolved.offset);
    const items = defs.map((d) =>
      toLocationItem(d.filePath, d.line, d.column, d.startOffset, d.endOffset, d.kind ?? 'definition', {
        isDefinition: true,
      })
    );
    return {
      scope: resolved.filePath,
      verification: 'semantic',
      data: {
        query: 'definition',
        targetSummary: `${resolved.symbolName} @ ${resolved.filePath}`,
        items,
      },
      omissions,
      diagnostics,
    };
  }

  if (request.query === 'references') {
    const candidatePackages = findCandidatePackagesForTarget(db, resolved, request.scope?.packages);
    const refs = semanticPool.findReferencesAtOffset(
      absRoot,
      resolved.filePath,
      resolved.offset,
      candidatePackages
    );
    const descriptors: RawLocationDescriptor[] = refs.map((r) => {
      const meta = getFileMeta(r.filePath);
      return {
        packageKey: meta.packageKey,
        filePath: r.filePath,
        relPath: meta.relPath,
        contentHash: meta.contentHash,
        line: r.line,
        column: r.column,
        startOffset: r.startOffset,
        endOffset: r.endOffset,
        kind: r.kind ?? 'reference',
        isDefinition: r.isDefinition,
        isWriteAccess: r.isWriteAccess,
      };
    });

    // Supplement semantic references with indexed graph edges (captures Nuxt auto-imports without .nuxt/imports.d.ts)
    if (resolved.symbolKind !== 'position' && resolved.symbolKind !== 'file') {
      const seenLineKeys = new Set(descriptors.map((item) => `${item.filePath}:${item.line}`));
      const candidatePkgSet = new Set(candidatePackages);
      const graphRows = db
        .query(
          `SELECT f.path AS file_path, f.rel_path, f.content_hash, p.package_key,
                  e.edge_kind, e.line_number, e.start_offset, e.end_offset
           FROM symbol_edges e
           JOIN files f ON f.id = e.source_file_id
           JOIN packages p ON p.id = f.package_id
           WHERE (e.target_file_id = ? OR (e.target_file_id IS NULL AND e.target_name = ?))
             AND e.source_file_id != ?
             AND e.edge_kind IN ('calls', 'renders', 'reads_state', 'writes_state')
           ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
        )
        .all(resolved.fileId, resolved.symbolName, resolved.fileId) as Array<{
        file_path: string;
        rel_path: string;
        content_hash: string;
        package_key: string;
        edge_kind: string;
        line_number: number;
        start_offset: number;
        end_offset: number;
      }>;

      for (const row of graphRows) {
        if (!candidatePkgSet.has(row.package_key)) continue;
        const key = `${row.file_path}:${row.line_number}`;
        if (seenLineKeys.has(key)) continue;
        seenLineKeys.add(key);
        descriptors.push({
          packageKey: row.package_key,
          filePath: row.file_path,
          relPath: row.rel_path,
          contentHash: row.content_hash,
          line: row.line_number,
          column: 1,
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          kind: `graph:${row.edge_kind}`,
          isWriteAccess: row.edge_kind === 'writes_state',
        });
      }
    }

    const { page, pagination } = paginateItems(descriptors, limit, request.cursor);

    return {
      scope: `${absRoot} (${candidatePackages.length} candidate package(s): ${candidatePackages.join(', ')})`,
      verification: 'semantic',
      data: {
        query: 'references',
        targetSummary: `${resolved.symbolName} (${resolved.symbolKind})`,
        items: page.map(buildFromDescriptor),
        summaryByPackage: summarizeByPackage(descriptors),
      },
      pagination,
      omissions,
      diagnostics,
    };
  }

  if (request.query === 'componentTree') {
    const direction = request.direction ?? 'up';
    const maxDepth = Math.max(1, Math.min(8, Math.trunc(request.scope?.maxDepth ?? 4)));
    const scopePkgs = request.scope?.packages ? new Set(request.scope.packages) : null;

    const getFileInfo = db.prepare(
      `SELECT f.id, f.path, f.rel_path, f.framework, f.is_page, p.package_key,
              (SELECT s.name FROM symbols s WHERE s.file_id = f.id AND s.kind = 'component' LIMIT 1) AS comp_name
       FROM files f
       JOIN packages p ON p.id = f.package_id
       WHERE f.id = ?`
    );

    const getParents = db.prepare(
      `SELECT DISTINCT e.source_file_id AS next_id, e.edge_kind
       FROM symbol_edges e
       WHERE e.target_file_id = ? AND e.edge_kind IN ('imports', 'reexports', 'renders')`
    );

    const getChildren = db.prepare(
      `SELECT DISTINCT e.target_file_id AS next_id, e.edge_kind
       FROM symbol_edges e
       WHERE e.source_file_id = ? AND e.target_file_id IS NOT NULL AND e.edge_kind IN ('imports', 'reexports', 'renders')`
    );

    // Also include auto-imported component renders matched by component name
    const getAutoParents = db.prepare(
      `SELECT DISTINCT e.source_file_id AS next_id
       FROM symbol_edges e
       WHERE e.target_file_id IS NULL AND e.target_name = ? AND e.edge_kind = 'renders'`
    );

    type FileInfoRow = {
      id: number;
      path: string;
      rel_path: string;
      framework: string;
      is_page: number;
      package_key: string;
      comp_name: string | null;
    };
    const fileInfoCache = new Map<number, FileInfoRow | null>();
    const readFileInfo = (id: number): FileInfoRow | null => {
      if (fileInfoCache.has(id)) return fileInfoCache.get(id)!;
      const row = (getFileInfo.get(id) as FileInfoRow | null) ?? null;
      fileInfoCache.set(id, row);
      return row;
    };

    const isRenderableComponentFile = (info: FileInfoRow): boolean => {
      if (info.comp_name || info.is_page === 1) return true;
      return /\.(?:vue|tsx|jsx|svelte|astro)$/i.test(info.rel_path);
    };

    // Respect request.limit when provided; cap total nodes to keep responses within MCP byte budgets
    const maxChildrenPerNode = request.limit !== undefined ? Math.max(1, request.limit) : 50;
    const MAX_COMPONENT_TREE_NODES = request.limit !== undefined ? Math.max(1, Math.min(500, request.limit * 10)) : 500;
    const expanded = new Set<number>();
    let totalNodes = 0;
    let truncated = false;

    const collectDirectComponentNeighbors = (
      fileId: number,
      dir: 'up' | 'down',
      info: FileInfoRow
    ): number[] => {
      const result = new Set<number>();
      const queue: Array<{ id: number; barrelHops: number }> = [];

      const enqueueNeighbors = (curId: number, curInfo: FileInfoRow, hops: number) => {
        if (dir === 'up') {
          for (const row of getParents.all(curId) as Array<{ next_id: number; edge_kind: string }>) {
            queue.push({ id: row.next_id, barrelHops: hops });
          }
          if (curInfo.comp_name) {
            for (const row of getAutoParents.all(curInfo.comp_name) as Array<{ next_id: number }>) {
              queue.push({ id: row.next_id, barrelHops: hops });
            }
          }
        } else {
          for (const row of getChildren.all(curId) as Array<{ next_id: number; edge_kind: string }>) {
            queue.push({ id: row.next_id, barrelHops: hops });
          }
        }
      };

      enqueueNeighbors(fileId, info, 0);
      const visited = new Set<number>([fileId]);

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        const nInfo = readFileInfo(item.id);
        if (!nInfo) continue;

        if (isRenderableComponentFile(nInfo)) {
          result.add(item.id);
        } else if (item.barrelHops < 1) {
          // Transparently traverse through barrel/re-export files without emitting them as component nodes
          enqueueNeighbors(item.id, nInfo, item.barrelHops + 1);
        }
      }
      return [...result];
    };

    const buildNode = (fileId: number, depth: number, pathVisited: Set<number>): ComponentTreeNodeItem => {
      const info = readFileInfo(fileId)!;
      totalNodes++;
      const node: ComponentTreeNodeItem = {
        packageKey: info.package_key,
        filePath: info.path,
        relPath: info.rel_path,
        componentName: info.comp_name ?? info.rel_path,
        depth,
        isPage: info.is_page === 1,
        children: [],
      };
      if (depth >= maxDepth || expanded.has(fileId)) return node;
      expanded.add(fileId);

      const nextIds = new Set<number>();
      if (direction === 'up' || direction === 'both') {
        for (const id of collectDirectComponentNeighbors(fileId, 'up', info)) {
          nextIds.add(id);
        }
      }
      if (direction === 'down' || direction === 'both') {
        for (const id of collectDirectComponentNeighbors(fileId, 'down', info)) {
          nextIds.add(id);
        }
      }

      for (const nextId of nextIds) {
        if (pathVisited.has(nextId)) continue;
        if (node.children.length >= maxChildrenPerNode || totalNodes >= MAX_COMPONENT_TREE_NODES) {
          truncated = true;
          break;
        }
        const nextInfo = readFileInfo(nextId);
        if (!nextInfo) continue;
        if (scopePkgs && !scopePkgs.has(nextInfo.package_key)) continue;
        pathVisited.add(nextId);
        node.children.push(buildNode(nextId, depth + 1, pathVisited));
        pathVisited.delete(nextId);
      }
      return node;
    };

    const tree = buildNode(resolved.fileId, 0, new Set([resolved.fileId]));
    if (truncated) {
      diagnostics.push({
        code: 'COMPONENT_TREE_TRUNCATED',
        message: `Component tree traversal reached the ${MAX_COMPONENT_TREE_NODES}-node cap; narrow scope.packages or reduce maxDepth for a focused view.`,
      });
    }

    return {
      scope: absRoot,
      verification: 'graph',
      data: {
        query: 'componentTree',
        targetSummary: `${resolved.symbolName} (${direction}, maxDepth=${maxDepth})`,
        tree,
      },
      omissions,
      diagnostics,
    };
  }

  if (request.query === 'callHierarchy') {
    const direction = request.direction ?? 'up';
    const descriptors: RawLocationDescriptor[] = [];

    if (direction === 'up' || direction === 'both') {
      const callerRows = db
        .query(
          `SELECT f.path AS file_path, f.rel_path, f.content_hash, p.package_key,
                  e.line_number, e.start_offset, e.end_offset, e.edge_kind
           FROM symbol_edges e
           JOIN files f ON f.id = e.source_file_id
           JOIN packages p ON p.id = f.package_id
           WHERE (e.target_file_id = ? OR (e.target_file_id IS NULL AND e.target_name = ?))
             AND (e.source_file_id != ? OR (e.target_name = ? AND e.edge_kind IN ('calls', 'listens_event')))
             AND e.edge_kind IN ('calls', 'renders', 'reads_state', 'writes_state', 'listens_event')
           ORDER BY f.path ASC, e.line_number ASC`
        )
        .all(resolved.fileId, resolved.symbolName, resolved.fileId, resolved.symbolName) as Array<{
        file_path: string;
        rel_path: string;
        content_hash: string;
        package_key: string;
        line_number: number;
        start_offset: number;
        end_offset: number;
        edge_kind: string;
      }>;
      for (const r of callerRows) {
        descriptors.push({
          packageKey: r.package_key,
          filePath: r.file_path,
          relPath: r.rel_path,
          contentHash: r.content_hash,
          line: r.line_number,
          column: 1,
          startOffset: r.start_offset,
          endOffset: r.end_offset,
          kind: `caller:${r.edge_kind}`,
        });
      }
    }

    if (direction === 'down' || direction === 'both') {
      const calleeRows = db
        .query(
          `SELECT COALESCE(tf.path, sf.path) AS file_path,
                  COALESCE(tf.rel_path, sf.rel_path) AS rel_path,
                  COALESCE(tf.content_hash, sf.content_hash) AS content_hash,
                  COALESCE(tp.package_key, sp.package_key) AS package_key,
                  e.line_number, e.start_offset, e.end_offset, e.edge_kind, e.target_name
           FROM symbol_edges e
           JOIN files sf ON sf.id = e.source_file_id
           JOIN packages sp ON sp.id = sf.package_id
           LEFT JOIN files tf ON tf.id = e.target_file_id
           LEFT JOIN packages tp ON tp.id = tf.package_id
           WHERE e.source_file_id = ?
             AND e.edge_kind IN ('calls', 'renders', 'outbound_http', 'reads_state', 'writes_state')
           ORDER BY e.line_number ASC`
        )
        .all(resolved.fileId) as Array<{
        file_path: string;
        rel_path: string;
        content_hash: string;
        package_key: string;
        line_number: number;
        start_offset: number;
        end_offset: number;
        edge_kind: string;
        target_name: string;
      }>;
      for (const r of calleeRows) {
        descriptors.push({
          packageKey: r.package_key,
          filePath: r.file_path,
          relPath: r.rel_path,
          contentHash: r.content_hash,
          line: r.line_number,
          column: 1,
          startOffset: r.start_offset,
          endOffset: r.end_offset,
          kind: `callee:${r.edge_kind}:${r.target_name}`,
        });
      }
    }

    const { page, pagination } = paginateItems(descriptors, limit, request.cursor);
    return {
      scope: absRoot,
      verification: 'graph',
      data: {
        query: 'callHierarchy',
        targetSummary: `${resolved.symbolName} (${direction})`,
        items: page.map(buildFromDescriptor),
        summaryByPackage: summarizeByPackage(descriptors),
      },
      pagination,
      omissions,
      diagnostics,
    };
  }

  // query === 'impact': verified consumer sites + explicit dynamic spread omissions
  const member = request.target.member;
  const candidatePackages = findCandidatePackagesForTarget(db, resolved, request.scope?.packages);
  const candidatePkgSet = new Set(candidatePackages);

  // 1. Single-SQL batch CTE: collect consumer render edges & surface DYNAMIC_SPREAD omissions without touching disk
  const impactRenderRows = db
    .query(
      `WITH RECURSIVE consumers(file_id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT e.source_file_id, 1
         FROM symbol_edges e
         WHERE e.target_file_id IS NULL
           AND e.target_name = ?
           AND e.edge_kind = 'renders'
         UNION
         SELECT e.source_file_id, c.depth + 1
         FROM symbol_edges e
         JOIN consumers c ON e.target_file_id = c.file_id
         WHERE c.depth < 3 AND e.edge_kind IN ('imports', 'reexports', 'renders')
       )
       SELECT f.id AS file_id, f.path, f.rel_path, f.content_hash, p.package_key,
              e.line_number, e.start_offset, e.end_offset, e.is_dynamic, e.payload_json
       FROM (SELECT DISTINCT file_id FROM consumers WHERE file_id != ?) c
       JOIN files f ON f.id = c.file_id
       JOIN packages p ON p.id = f.package_id
       JOIN symbol_edges e ON e.source_file_id = f.id
       WHERE e.edge_kind = 'renders'
         AND (e.target_file_id = ? OR e.target_name = ?)
       ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
    )
    .all(resolved.fileId, resolved.symbolName, resolved.fileId, resolved.fileId, resolved.symbolName) as Array<{
    file_id: number;
    path: string;
    rel_path: string;
    content_hash: string;
    package_key: string;
    line_number: number;
    start_offset: number;
    end_offset: number;
    is_dynamic: number;
    payload_json: string | null;
  }>;

  const impactDescriptors: RawLocationDescriptor[] = [];
  let verification: VerificationTier = 'graph';

  for (const edge of impactRenderRows) {
    if (!candidatePkgSet.has(edge.package_key)) continue;

    const payload = edge.payload_json
      ? (JSON.parse(edge.payload_json) as {
          props?: string[];
          events?: string[];
          hasDynamicSpread?: boolean;
        })
      : {};

    const matchesMember =
      !member ||
      (payload.props ?? []).includes(member) ||
      (payload.events ?? []).includes(member);
    const isDynamicSpread = Boolean(payload.hasDynamicSpread || edge.is_dynamic === 1);
    if (!matchesMember && !isDynamicSpread) continue;

    if (matchesMember) {
      impactDescriptors.push({
        packageKey: edge.package_key,
        filePath: edge.path,
        relPath: edge.rel_path,
        contentHash: edge.content_hash,
        line: edge.line_number,
        column: 1,
        startOffset: edge.start_offset,
        endOffset: edge.end_offset,
        kind: member ? `component-member:${member}` : 'component-render',
      });
    }

    if (isDynamicSpread) {
      const hash8 = edge.content_hash ? shortHashFromFull(edge.content_hash) : shortHash('');
      omissions.push({
        code: 'DYNAMIC_SPREAD',
        filePath: edge.path,
        line: edge.line_number,
        column: 1,
        reason: `Dynamic attribute spread on <${resolved.symbolName}> may pass or override "${member ?? 'props'}" at runtime.`,
        sourceRef: formatSourceRef(edge.path, hash8, edge.start_offset, edge.end_offset),
      });
    }
  }

  // 2. Supplement with TypeScript semantic references for non-component symbols or member definitions
  if (resolved.symbolKind !== 'component') {
    const refs = semanticPool.findReferencesAtOffset(
      absRoot,
      resolved.filePath,
      resolved.offset,
      candidatePackages
    );
    verification = 'semantic';
    for (const r of refs) {
      if (r.isDefinition) continue;
      const meta = getFileMeta(r.filePath);
      impactDescriptors.push({
        packageKey: meta.packageKey,
        filePath: r.filePath,
        relPath: meta.relPath,
        contentHash: meta.contentHash,
        line: r.line,
        column: r.column,
        startOffset: r.startOffset,
        endOffset: r.endOffset,
        kind: 'semantic-reference',
        isWriteAccess: r.isWriteAccess,
      });
    }
  }

  const { page, pagination } = paginateItems(impactDescriptors, limit, request.cursor);

  return {
    scope: `${absRoot} (${candidatePackages.length} candidate package(s): ${candidatePackages.join(', ')})`,
    verification,
    data: {
      query: 'impact',
      targetSummary: member ? `${resolved.symbolName}#${member}` : resolved.symbolName,
      items: page.map(buildFromDescriptor),
      summaryByPackage: summarizeByPackage(impactDescriptors),
    },
    pagination,
    omissions,
    diagnostics,
  };
}
