import { existsSync, readFileSync } from 'node:fs';
import { lineStarts, positionFromLineStarts } from '../../utils/source-position';
import { canonicalizePath } from '../path-resolver';
import {
  paginateItems,
  type QueryEnvelope,
  type ServiceRuntimeOptions,
} from './contracts';
import { ValidationError } from './errors';
import { defaultSyncCoordinator } from './sync-coordinator';
import { defaultWarmDbPool } from './schema-v3';
import { formatSourceRef, shortHash, shortHashFromFull } from './source-ref';

export type CodeSearchKind = 'symbol' | 'componentUsage' | 'propUsage' | 'text';

export interface SearchCodeRequest extends ServiceRuntimeOptions {
  workspaceRoot: string;
  query: string;
  kind?: CodeSearchKind;
  symbolKinds?: string[];
  packageKey?: string;
  pathPrefix?: string;
  limit?: number;
  cursor?: string;
}

export interface CodeSearchMatchItem {
  packageKey: string;
  filePath: string;
  relPath: string;
  line: number;
  column: number;
  kind: string;
  name: string;
  snippet: string;
  symbolId?: string;
  sourceRef: string;
}

const VALID_SEARCH_KINDS = new Set<CodeSearchKind>(['symbol', 'componentUsage', 'propUsage', 'text']);

function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.trim().replace(/['"`*():^]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' ');
}

/**
 * Code Discovery Service (In-Process, Zero ast-grep):
 * Uses SQLite FTS5 for instant workspace symbol search and indexed graph/text scanning
 * for component usage, prop usage, and scoped literal text search.
 */
export async function searchCode(
  request: SearchCodeRequest
): Promise<QueryEnvelope<{ kind: CodeSearchKind; matches: CodeSearchMatchItem[] }>> {
  const query = request.query?.trim();
  if (!query) {
    throw new ValidationError('searchCode requires a non-empty query string.');
  }

  const kind: CodeSearchKind = request.kind ?? 'symbol';
  if (!VALID_SEARCH_KINDS.has(kind)) {
    throw new ValidationError(
      `Invalid search kind "${String(kind)}". Expected one of: symbol, componentUsage, propUsage, text.`
    );
  }

  const absRoot = canonicalizePath(request.workspaceRoot);
  const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });
  if (!request.skipSync) {
    await defaultSyncCoordinator.ensureSynced(absRoot, { db, packageKey: request.packageKey });
  }

  const limit = request.limit ?? 30;
  const prefix = request.pathPrefix ? request.pathPrefix.replace(/\\/g, '/').replace(/^\/+/, '') : null;
  const scope = request.packageKey ? `${absRoot} (package: ${request.packageKey})` : absRoot;

  if (kind === 'symbol') {
    const ftsExpr = sanitizeFtsQuery(query);
    const rows = ftsExpr
      ? (db
          .query(
            `SELECT s.symbol_uid, s.name, s.kind, s.signature, s.start_line, s.start_offset, s.end_offset,
                    f.path AS file_path, f.rel_path, f.content_hash, p.package_key
             FROM symbols_fts fts
             JOIN symbols s ON s.id = fts.rowid
             JOIN files f ON f.id = s.file_id
             JOIN packages p ON p.id = s.package_id
             WHERE symbols_fts MATCH ?
               AND (? IS NULL OR p.package_key = ?)
               AND (? IS NULL OR f.rel_path LIKE ? || '%')
             ORDER BY bm25(symbols_fts), p.package_key ASC, f.rel_path ASC`
          )
          .all(ftsExpr, request.packageKey ?? null, request.packageKey ?? null, prefix, prefix) as Array<{
          symbol_uid: string;
          name: string;
          kind: string;
          signature: string | null;
          start_line: number;
          start_offset: number;
          end_offset: number;
          file_path: string;
          rel_path: string;
          content_hash: string;
          package_key: string;
        }>)
      : [];

    const kindFilter = request.symbolKinds?.length ? new Set(request.symbolKinds) : null;
    const filtered = kindFilter ? rows.filter((r) => kindFilter.has(r.kind)) : rows;

    const { page: pagedRows, pagination } = paginateItems(filtered, limit, request.cursor);
    const page: CodeSearchMatchItem[] = pagedRows.map((r) => ({
      packageKey: r.package_key,
      filePath: r.file_path,
      relPath: r.rel_path,
      line: r.start_line,
      column: 1,
      kind: r.kind,
      name: r.name,
      snippet: r.signature ?? r.name,
      symbolId: r.symbol_uid,
      sourceRef: formatSourceRef(
        r.file_path,
        shortHashFromFull(r.content_hash),
        r.start_offset,
        r.end_offset
      ),
    }));

    return {
      scope,
      verification: 'graph',
      data: { kind, matches: page },
      pagination,
      omissions: [],
      diagnostics: [],
    };
  }

  if (kind === 'componentUsage' || kind === 'propUsage') {
    const pascalQuery = query.includes('-')
      ? query
          .split('-')
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('')
      : query;

    const rows =
      kind === 'componentUsage'
        ? (db
            .query(
              `SELECT e.target_name, e.line_number, e.start_offset, e.end_offset, e.payload_json,
                      f.path AS file_path, f.rel_path, f.content_hash, p.package_key
               FROM symbol_edges e
               JOIN files f ON f.id = e.source_file_id
               JOIN packages p ON p.id = f.package_id
               WHERE e.edge_kind = 'renders'
                 AND (e.target_name = ? COLLATE NOCASE OR e.target_name = ? COLLATE NOCASE)
                 AND (? IS NULL OR p.package_key = ?)
                 AND (? IS NULL OR f.rel_path LIKE ? || '%')
               ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
            )
            .all(
              query,
              pascalQuery,
              request.packageKey ?? null,
              request.packageKey ?? null,
              prefix,
              prefix
            ) as Array<{
            target_name: string;
            line_number: number;
            start_offset: number;
            end_offset: number;
            payload_json: string | null;
            file_path: string;
            rel_path: string;
            content_hash: string;
            package_key: string;
          }>)
        : (db
            .query(
              `SELECT e.target_name, e.line_number, e.start_offset, e.end_offset, e.payload_json,
                      f.path AS file_path, f.rel_path, f.content_hash, p.package_key
               FROM symbol_edges e
               JOIN files f ON f.id = e.source_file_id
               JOIN packages p ON p.id = f.package_id
               WHERE e.edge_kind = 'renders'
                 AND e.payload_json LIKE '%' || ? || '%'
                 AND (? IS NULL OR p.package_key = ?)
                 AND (? IS NULL OR f.rel_path LIKE ? || '%')
               ORDER BY p.package_key ASC, f.rel_path ASC, e.line_number ASC`
            )
            .all(query, request.packageKey ?? null, request.packageKey ?? null, prefix, prefix) as Array<{
            target_name: string;
            line_number: number;
            start_offset: number;
            end_offset: number;
            payload_json: string | null;
            file_path: string;
            rel_path: string;
            content_hash: string;
            package_key: string;
          }>);

    const hitRows =
      kind === 'componentUsage'
        ? rows
        : rows.filter((r) => {
            if (!r.payload_json || !r.payload_json.includes(query)) return false;
            const payload = JSON.parse(r.payload_json) as { props?: string[]; events?: string[] };
            return (payload.props ?? []).includes(query) || (payload.events ?? []).includes(query);
          });

    const { page: pagedRows, pagination } = paginateItems(hitRows, limit, request.cursor);
    const linesCache = new Map<string, string[]>();
    const page: CodeSearchMatchItem[] = pagedRows.map((r) => {
      let lines = linesCache.get(r.file_path);
      if (!lines) {
        const raw = existsSync(r.file_path) ? readFileSync(r.file_path, 'utf8') : '';
        lines = raw ? raw.split('\n') : [];
        linesCache.set(r.file_path, lines);
      }
      const lineText =
        lines.length > 0 ? (lines[r.line_number - 1] ?? '').trim().slice(0, 140) : r.target_name;
      return {
        packageKey: r.package_key,
        filePath: r.file_path,
        relPath: r.rel_path,
        line: r.line_number,
        column: 1,
        kind,
        name: kind === 'componentUsage' ? r.target_name : `${r.target_name}#${query}`,
        snippet: lineText,
        sourceRef: formatSourceRef(
          r.file_path,
          shortHashFromFull(r.content_hash),
          r.start_offset,
          r.end_offset
        ),
      };
    });

    return {
      scope,
      verification: 'graph',
      data: { kind, matches: page },
      pagination,
      omissions: [],
      diagnostics: [],
    };
  }

  // kind === 'text': scoped literal search over indexed frontend files
  const fileRows = db
    .query(
      `SELECT f.path AS file_path, f.rel_path, p.package_key
       FROM files f
       JOIN packages p ON p.id = f.package_id
       WHERE (? IS NULL OR p.package_key = ?)
         AND (? IS NULL OR f.rel_path LIKE ? || '%')
       ORDER BY p.package_key ASC, f.rel_path ASC`
    )
    .all(request.packageKey ?? null, request.packageKey ?? null, prefix, prefix) as Array<{
    file_path: string;
    rel_path: string;
    package_key: string;
  }>;

  const matches: CodeSearchMatchItem[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of fileRows) {
    if (!existsSync(file.file_path)) continue;
    const raw = readFileSync(file.file_path, 'utf8');
    const lowerRaw = raw.toLowerCase();
    let idx = lowerRaw.indexOf(lowerQuery);
    if (idx === -1) continue;

    const hash8 = shortHash(raw);
    const lines = raw.split('\n');
    const starts = lineStarts(raw);
    while (idx !== -1) {
      const pos = positionFromLineStarts(starts, idx);
      matches.push({
        packageKey: file.package_key,
        filePath: file.file_path,
        relPath: file.rel_path,
        line: pos.line,
        column: pos.column,
        kind: 'text',
        name: query,
        snippet: (lines[pos.line - 1] ?? '').trim().slice(0, 140),
        sourceRef: formatSourceRef(file.file_path, hash8, idx, idx + query.length),
      });
      if (matches.length >= 500) break;
      idx = lowerRaw.indexOf(lowerQuery, idx + query.length);
    }
    if (matches.length >= 500) break;
  }

  const { page, pagination } = paginateItems(matches, limit, request.cursor);
  return {
    scope,
    verification: 'graph',
    data: { kind, matches: page },
    pagination,
    omissions: [],
    diagnostics: [],
  };
}
