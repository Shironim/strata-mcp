import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { getSourcePosition } from '../../utils/source-position';
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
import { syncWorkspaceV3 } from './fast-sync';
import { defaultWarmDbPool } from './schema-v3';
import { defaultSemanticPool } from './semantic';
import {
  formatSourceRef,
  resolvePathWithinWorkspace,
  shortHash,
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

function summarizeByPackage(items: readonly GraphLocationItem[]): PackageGroupSummary[] {
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

function toLocationItem(
  db: Database,
  filePath: string,
  line: number,
  column: number,
  startOffset: number,
  endOffset: number,
  kind: string,
  extra?: { isDefinition?: boolean; isWriteAccess?: boolean }
): GraphLocationItem {
  const row = db
    .query(
      `SELECT f.rel_path, p.package_key
       FROM files f
       JOIN packages p ON p.id = f.package_id
       WHERE f.path = ?`
    )
    .get(filePath) as { rel_path: string; package_key: string } | null;

  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const hash8 = shortHash(raw);
  return {
    packageKey: row?.package_key ?? '.',
    filePath,
    relPath: row?.rel_path ?? filePath,
    line,
    column,
    kind,
    snippet: raw ? lineSnippet(raw, line) : '',
    sourceRef: formatSourceRef(filePath, hash8, startOffset, endOffset),
    ...extra,
  };
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
    await syncWorkspaceV3(absRoot, { db });
  }

  const semanticPool = request.semanticPool ?? defaultSemanticPool;
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
    const rows = db
      .query(
        `SELECT f.path AS file_path, f.rel_path, p.package_key,
                e.edge_kind, e.line_number, e.start_offset, e.end_offset
         FROM symbol_edges e
         JOIN files f ON f.id = e.source_file_id
         JOIN packages p ON p.id = f.package_id
         WHERE e.target_name = ?
           AND e.edge_kind IN ('reads_state', 'writes_state', 'watches_state', 'calls')
         ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
      )
      .all(stateName) as Array<{
      file_path: string;
      rel_path: string;
      package_key: string;
      edge_kind: string;
      line_number: number;
      start_offset: number;
      end_offset: number;
    }>;

    const filtered = scopePkgs?.length
      ? rows.filter((r) => scopePkgs.includes(r.package_key))
      : rows;

    const items = filtered.map((r) =>
      toLocationItem(db, r.file_path, r.line_number, 1, r.start_offset, r.end_offset, r.edge_kind)
    );
    const { page, pagination } = paginateItems(items, limit, request.cursor);

    return {
      scope: absRoot,
      verification: 'graph',
      data: {
        query: 'stateFlow',
        targetSummary: `state:${stateName}`,
        items: page,
        summaryByPackage: summarizeByPackage(items),
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
      toLocationItem(db, d.filePath, d.line, d.column, d.startOffset, d.endOffset, d.kind ?? 'definition', {
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
    const allItems = refs.map((r) =>
      toLocationItem(db, r.filePath, r.line, r.column, r.startOffset, r.endOffset, r.kind ?? 'reference', {
        isDefinition: r.isDefinition,
        isWriteAccess: r.isWriteAccess,
      })
    );
    const { page, pagination } = paginateItems(allItems, limit, request.cursor);

    return {
      scope: `${absRoot} (${candidatePackages.length} candidate package(s): ${candidatePackages.join(', ')})`,
      verification: 'semantic',
      data: {
        query: 'references',
        targetSummary: `${resolved.symbolName} (${resolved.symbolKind})`,
        items: page,
        summaryByPackage: summarizeByPackage(allItems),
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
      `SELECT f.id, f.path, f.rel_path, f.is_page, p.package_key,
              (SELECT s.name FROM symbols s WHERE s.file_id = f.id AND s.kind = 'component' LIMIT 1) AS comp_name
       FROM files f
       JOIN packages p ON p.id = f.package_id
       WHERE f.id = ?`
    );

    const getParents = db.prepare(
      `SELECT DISTINCT e.source_file_id AS next_id
       FROM symbol_edges e
       WHERE e.target_file_id = ? AND e.edge_kind IN ('imports', 'reexports', 'renders')`
    );

    const getChildren = db.prepare(
      `SELECT DISTINCT e.target_file_id AS next_id
       FROM symbol_edges e
       WHERE e.source_file_id = ? AND e.target_file_id IS NOT NULL AND e.edge_kind IN ('imports', 'reexports', 'renders')`
    );

    // Also include auto-imported component renders matched by component name
    const getAutoParents = db.prepare(
      `SELECT DISTINCT e.source_file_id AS next_id
       FROM symbol_edges e
       WHERE e.target_file_id IS NULL AND e.target_name = ? AND e.edge_kind = 'renders'`
    );

    const buildNode = (fileId: number, depth: number, visited: Set<number>): ComponentTreeNodeItem => {
      const info = getFileInfo.get(fileId) as {
        id: number;
        path: string;
        rel_path: string;
        is_page: number;
        package_key: string;
        comp_name: string | null;
      };
      const node: ComponentTreeNodeItem = {
        packageKey: info.package_key,
        filePath: info.path,
        relPath: info.rel_path,
        componentName: info.comp_name ?? info.rel_path,
        depth,
        isPage: info.is_page === 1,
        children: [],
      };
      if (depth >= maxDepth) return node;

      const nextIds = new Set<number>();
      if (direction === 'up' || direction === 'both') {
        for (const row of getParents.all(fileId) as Array<{ next_id: number }>) {
          nextIds.add(row.next_id);
        }
        if (info.comp_name) {
          for (const row of getAutoParents.all(info.comp_name) as Array<{ next_id: number }>) {
            nextIds.add(row.next_id);
          }
        }
      }
      if (direction === 'down' || direction === 'both') {
        for (const row of getChildren.all(fileId) as Array<{ next_id: number }>) {
          nextIds.add(row.next_id);
        }
      }

      for (const nextId of nextIds) {
        if (visited.has(nextId)) continue;
        const nextInfo = getFileInfo.get(nextId) as { package_key: string } | null;
        if (!nextInfo) continue;
        if (scopePkgs && !scopePkgs.has(nextInfo.package_key)) continue;
        const nextVisited = new Set(visited);
        nextVisited.add(nextId);
        node.children.push(buildNode(nextId, depth + 1, nextVisited));
      }
      return node;
    };

    const tree = buildNode(resolved.fileId, 0, new Set([resolved.fileId]));

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
    const items: GraphLocationItem[] = [];

    if (direction === 'up' || direction === 'both') {
      const callerRows = db
        .query(
          `SELECT f.path AS file_path, e.line_number, e.start_offset, e.end_offset, e.edge_kind
           FROM symbol_edges e
           JOIN files f ON f.id = e.source_file_id
           WHERE (e.target_file_id = ? OR e.target_name = ?)
             AND e.source_file_id != ?
             AND e.edge_kind IN ('calls', 'renders', 'reads_state', 'writes_state')
           ORDER BY f.path ASC, e.line_number ASC`
        )
        .all(resolved.fileId, resolved.symbolName, resolved.fileId) as Array<{
        file_path: string;
        line_number: number;
        start_offset: number;
        end_offset: number;
        edge_kind: string;
      }>;
      for (const r of callerRows) {
        items.push(
          toLocationItem(db, r.file_path, r.line_number, 1, r.start_offset, r.end_offset, `caller:${r.edge_kind}`)
        );
      }
    }

    if (direction === 'down' || direction === 'both') {
      const calleeRows = db
        .query(
          `SELECT COALESCE(tf.path, sf.path) AS file_path, e.line_number, e.start_offset, e.end_offset, e.edge_kind, e.target_name
           FROM symbol_edges e
           JOIN files sf ON sf.id = e.source_file_id
           LEFT JOIN files tf ON tf.id = e.target_file_id
           WHERE e.source_file_id = ?
             AND e.edge_kind IN ('calls', 'renders', 'outbound_http', 'reads_state', 'writes_state')
           ORDER BY e.line_number ASC`
        )
        .all(resolved.fileId) as Array<{
        file_path: string;
        line_number: number;
        start_offset: number;
        end_offset: number;
        edge_kind: string;
        target_name: string;
      }>;
      for (const r of calleeRows) {
        items.push(
          toLocationItem(db, r.file_path, r.line_number, 1, r.start_offset, r.end_offset, `callee:${r.edge_kind}:${r.target_name}`)
        );
      }
    }

    const { page, pagination } = paginateItems(items, limit, request.cursor);
    return {
      scope: absRoot,
      verification: 'graph',
      data: {
        query: 'callHierarchy',
        targetSummary: `${resolved.symbolName} (${direction})`,
        items: page,
        summaryByPackage: summarizeByPackage(items),
      },
      pagination,
      omissions,
      diagnostics,
    };
  }

  // query === 'impact': verified consumer sites + explicit dynamic spread omissions
  const member = request.target.member;
  const candidatePackages = findCandidatePackagesForTarget(db, resolved, request.scope?.packages);

  // Collect all consumer files across candidate packages (follows barrel re-exports via recursive CTE)
  const consumerRows = db
    .query(
      `WITH RECURSIVE consumers(file_id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT e.source_file_id, c.depth + 1
         FROM symbol_edges e
         JOIN consumers c ON e.target_file_id = c.file_id
         WHERE c.depth < 3 AND e.edge_kind IN ('imports', 'reexports', 'renders')
       )
       SELECT DISTINCT f.id, f.path, f.rel_path, f.content_hash, f.contract_json, p.package_key
       FROM consumers c
       JOIN files f ON f.id = c.file_id
       JOIN packages p ON p.id = f.package_id
       WHERE f.id != ?`
    )
    .all(resolved.fileId, resolved.fileId) as Array<{
    id: number;
    path: string;
    rel_path: string;
    content_hash: string;
    contract_json: string | null;
    package_key: string;
  }>;

  const impactItems: GraphLocationItem[] = [];
  let verification: VerificationTier = 'graph';

  // 1. Check indexed render edges & surface DYNAMIC_SPREAD omissions on consumer files
  for (const consumer of consumerRows) {
    if (!candidatePackages.includes(consumer.package_key)) continue;

    const renderEdges = db
      .query(
        `SELECT line_number, start_offset, end_offset, is_dynamic, payload_json
         FROM symbol_edges
         WHERE source_file_id = ? AND edge_kind = 'renders' AND target_name = ?`
      )
      .all(consumer.id, resolved.symbolName) as Array<{
      line_number: number;
      start_offset: number;
      end_offset: number;
      is_dynamic: number;
      payload_json: string | null;
    }>;

    const raw = existsSync(consumer.path) ? readFileSync(consumer.path, 'utf8') : '';
    const hash8 = shortHash(raw);

    for (const edge of renderEdges) {
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

      if (matchesMember) {
        const pos = getSourcePosition(raw, edge.start_offset);
        impactItems.push(
          toLocationItem(
            db,
            consumer.path,
            pos.line,
            pos.column,
            edge.start_offset,
            edge.end_offset,
            member ? `component-member:${member}` : 'component-render'
          )
        );
      }

      if (payload.hasDynamicSpread || edge.is_dynamic === 1) {
        const pos = getSourcePosition(raw, edge.start_offset);
        omissions.push({
          code: 'DYNAMIC_SPREAD',
          filePath: consumer.path,
          line: pos.line,
          column: pos.column,
          reason: `Dynamic attribute spread on <${resolved.symbolName}> may pass or override "${member ?? 'props'}" at runtime.`,
          sourceRef: formatSourceRef(consumer.path, hash8, edge.start_offset, edge.end_offset),
        });
      }
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
      impactItems.push(
        toLocationItem(db, r.filePath, r.line, r.column, r.startOffset, r.endOffset, 'semantic-reference', {
          isWriteAccess: r.isWriteAccess,
        })
      );
    }
  }

  const { page, pagination } = paginateItems(impactItems, limit, request.cursor);

  return {
    scope: `${absRoot} (${candidatePackages.length} candidate package(s): ${candidatePackages.join(', ')})`,
    verification,
    data: {
      query: 'impact',
      targetSummary: member ? `${resolved.symbolName}#${member}` : resolved.symbolName,
      items: page,
      summaryByPackage: summarizeByPackage(impactItems),
    },
    pagination,
    omissions,
    diagnostics,
  };
}
