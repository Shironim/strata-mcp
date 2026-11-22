import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { defaultPluginRegistry } from '../../plugins';
import { assertSafeOffset, lineStarts, positionFromLineStarts } from '../../utils/source-position';
import { canonicalizePath } from '../path-resolver';
import type {
  DiagnosticRecord,
  OmissionRecord,
  QueryEnvelope,
  ServiceRuntimeOptions,
  VerificationTier,
} from './contracts';
import { NotFoundError, ValidationError } from './errors';
import { defaultSyncCoordinator } from './sync-coordinator';
import { defaultWarmDbPool } from './schema-v3';
import { defaultSemanticPool, type SemanticPropInfo } from './semantic';
import {
  formatSourceRef,
  resolvePathWithinWorkspace,
  shortHashFromFull,
} from './source-ref';

export type InspectSection = 'outline' | 'contract' | 'boundaries' | 'imports';

export interface InspectFileRequest extends ServiceRuntimeOptions {
  workspaceRoot: string;
  path: string;
  sections?: InspectSection[];
  resolveTypes?: boolean;
}

export interface OutlineSymbolItem {
  symbolId: string;
  name: string;
  kind: string;
  isExported: boolean;
  isDefault: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  sourceRef: string;
}

export interface BoundaryBackendTargetHint {
  endpoint: string;
  method: string;
  filePath: string;
  relPath: string;
}

export interface OutboundHttpBoundaryItem {
  client: string;
  method: string;
  url: string;
  filePath: string;
  line: number;
  source: 'inline' | 'composable';
  viaSymbol?: string;
  backendTargetHint?: BoundaryBackendTargetHint;
}

export interface ImportSummaryItem {
  specifier: string;
  resolvedFilePath: string | null;
  isTypeOnly: boolean;
  line: number;
}

export interface VueModelContractItem {
  name: string;
  type?: string;
  required: boolean;
}

export interface FileInspectionData {
  filePath: string;
  packageKey: string;
  framework: string;
  renderBoundary: string;
  boundaryDirective: string | null;
  outline?: OutlineSymbolItem[];
  contract?: {
    props: SemanticPropInfo[];
    emits: string[];
    models: VueModelContractItem[];
    slots: string[];
    renderedComponents: string[];
  };
  boundaries?: {
    outboundHttp: OutboundHttpBoundaryItem[];
  };
  imports?: ImportSummaryItem[];
}

const VALID_SECTIONS = new Set<InspectSection>(['outline', 'contract', 'boundaries', 'imports']);

function extractHttpMethodFromCall(
  rawContent: string,
  startOffset: number,
  endOffset: number,
  payloadMethod?: string
): string {
  if (payloadMethod && typeof payloadMethod === 'string') {
    return payloadMethod.toUpperCase();
  }
  const snippet = rawContent.slice(startOffset, endOffset);
  const literalMatch = /\bmethod\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i.exec(snippet);
  if (literalMatch) return literalMatch[1].toUpperCase();
  if (/\bmethod\s*:/i.test(snippet)) return 'DYNAMIC';
  return 'GET';
}

function normalizeHttpUrl(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      const leaf = expr.trim().split('.').pop() ?? 'param';
      return `:${leaf.replace(/[^a-zA-Z0-9_]/g, '')}`;
    });
}

/**
 * File Inspection Service (Outline & Public Contract — body-free):
 * Combines indexed SQLite symbols/edges with TypeScript TypeChecker prop expansion
 * and 1-hop semantic composable outbound-HTTP tracing.
 */
export async function inspectFile(
  request: InspectFileRequest
): Promise<QueryEnvelope<FileInspectionData>> {
  const absRoot = canonicalizePath(request.workspaceRoot);
  const targetFile = resolvePathWithinWorkspace(absRoot, request.path);
  if (!existsSync(targetFile)) {
    throw new NotFoundError(`File not found: "${targetFile}"`);
  }

  const sections: InspectSection[] = request.sections?.length
    ? request.sections
    : ['outline', 'contract', 'boundaries'];
  for (const s of sections) {
    if (!VALID_SECTIONS.has(s)) {
      throw new ValidationError(
        `Invalid inspect section "${String(s)}". Expected one of: outline, contract, boundaries, imports.`
      );
    }
  }

  const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });
  if (!request.skipSync) {
    await defaultSyncCoordinator.ensureSynced(absRoot, { db });
  }

  const fileRow = db
    .query(
      `SELECT f.id, f.path, f.rel_path, f.framework, f.content_hash,
              f.render_boundary, f.boundary_directive, f.contract_json,
              p.package_key
       FROM files f
       JOIN packages p ON p.id = f.package_id
       WHERE f.path = ?`
    )
    .get(targetFile) as {
    id: number;
    path: string;
    rel_path: string;
    framework: string;
    content_hash: string;
    render_boundary: string | null;
    boundary_directive: string | null;
    contract_json: string | null;
    package_key: string;
  } | null;

  if (!fileRow) {
    throw new NotFoundError(`File is not indexed as a supported frontend source file: "${targetFile}"`);
  }

  const rawContent = readFileSync(targetFile, 'utf8');
  const hash8 = shortHashFromFull(fileRow.content_hash);
  const resolveTypes = request.resolveTypes !== false;
  const semanticPool = request.semanticPool ?? defaultSemanticPool;

  let verification: VerificationTier = 'graph';
  const omissions: OmissionRecord[] = [];
  const diagnostics: DiagnosticRecord[] = [];

  // Surface projection omissions (e.g. dynamic spreads) from indexed contract metadata
  const parsedContract = fileRow.contract_json
    ? (JSON.parse(fileRow.contract_json) as {
        slots?: string[];
        emits?: string[];
        models?: VueModelContractItem[];
        omissions?: Array<{ code: string; originalStart: number; originalEnd: number; reason: string }>;
      })
    : {};

  const rawOmissions = parsedContract.omissions ?? [];
  if (rawOmissions.length > 0) {
    const rawStarts = lineStarts(rawContent);
    for (const om of rawOmissions) {
      assertSafeOffset(rawContent, om.originalStart);
      const pos = positionFromLineStarts(rawStarts, om.originalStart);
      omissions.push({
        code: om.code,
        filePath: targetFile,
        line: pos.line,
        column: pos.column,
        reason: om.reason,
        sourceRef: formatSourceRef(targetFile, hash8, om.originalStart, om.originalEnd),
      });
    }
  }

  const data: FileInspectionData = {
    filePath: targetFile,
    packageKey: fileRow.package_key,
    framework: fileRow.framework,
    renderBoundary: fileRow.render_boundary ?? 'universal',
    boundaryDirective: fileRow.boundary_directive,
  };

  if (sections.includes('outline')) {
    const symRows = db
      .query(
        `SELECT symbol_uid, name, kind, is_exported, is_default, signature,
                start_offset, end_offset, start_line, end_line
         FROM symbols
         WHERE file_id = ?
         ORDER BY start_offset ASC, id ASC`
      )
      .all(fileRow.id) as Array<{
      symbol_uid: string;
      name: string;
      kind: string;
      is_exported: number;
      is_default: number;
      signature: string | null;
      start_offset: number;
      end_offset: number;
      start_line: number;
      end_line: number;
    }>;

    data.outline = symRows.map((s) => ({
      symbolId: s.symbol_uid,
      name: s.name,
      kind: s.kind,
      isExported: s.is_exported === 1,
      isDefault: s.is_default === 1,
      signature: s.signature ?? s.name,
      startLine: s.start_line,
      endLine: s.end_line,
      sourceRef: formatSourceRef(targetFile, hash8, s.start_offset, s.end_offset),
    }));
  }

  if (sections.includes('contract')) {
    let props: SemanticPropInfo[] = [];
    let emits: string[] = parsedContract.emits ?? [];
    if (resolveTypes) {
      try {
        props = semanticPool.expandComponentProps(absRoot, targetFile);
        if (emits.length === 0 && fileRow.framework === 'vue') {
          emits = semanticPool.expandComponentEmits(absRoot, targetFile);
        }
        verification = 'semantic';
      } catch (err) {
        verification = 'syntax-fallback';
        diagnostics.push({
          code: 'SEMANTIC_PROP_EXPANSION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          filePath: targetFile,
        });
      }
    } else {
      diagnostics.push({
        code: 'CONTRACT_TYPES_UNRESOLVED',
        message: 'resolve_types is false; set resolve_types=true to expand TypeScript component prop and emit types.',
        filePath: targetFile,
      });
    }

    const renderedRows = db
      .query(
        `SELECT DISTINCT target_name
         FROM symbol_edges
         WHERE source_file_id = ? AND edge_kind = 'renders'
         ORDER BY target_name ASC`
      )
      .all(fileRow.id) as Array<{ target_name: string }>;

    data.contract = {
      props,
      emits,
      models: parsedContract.models ?? [],
      slots: parsedContract.slots ?? [],
      renderedComponents: renderedRows.map((r) => r.target_name),
    };
  }

  if (sections.includes('boundaries')) {
    const outboundHttp: OutboundHttpBoundaryItem[] = [];
    const seenBoundary = new Set<string>();

    // 1. Direct inline outbound_http edges from the SQLite index
    const inlineRows = db
      .query(
        `SELECT target_name, line_number, start_offset, end_offset, payload_json
         FROM symbol_edges
         WHERE source_file_id = ? AND edge_kind = 'outbound_http'
         ORDER BY line_number ASC`
      )
      .all(fileRow.id) as Array<{
      target_name: string;
      line_number: number;
      start_offset: number;
      end_offset: number;
      payload_json: string | null;
    }>;

    for (const row of inlineRows) {
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json) as { client?: string; url?: string; method?: string; isDynamicMethod?: boolean })
        : {};
      const method = extractHttpMethodFromCall(rawContent, row.start_offset, row.end_offset, payload.method);
      const url = normalizeHttpUrl(payload.url ?? row.target_name);
      const key = `${method}:${url}:${targetFile}:${row.line_number}`;
      if (seenBoundary.has(key)) continue;
      seenBoundary.add(key);
      if (method === 'DYNAMIC' || payload.isDynamicMethod) {
        diagnostics.push({
          code: 'DYNAMIC_HTTP_METHOD',
          message: `HTTP method for "${url}" at line ${row.line_number} is determined dynamically at runtime.`,
          filePath: targetFile,
        });
      }
      outboundHttp.push({
        client: payload.client ?? 'fetch',
        method,
        url,
        filePath: targetFile,
        line: row.line_number,
        source: 'inline',
      });
    }

    // 2. Graph-first 1-hop tracing through imported OR auto-imported composables/functions
    const graphCoveredCalls = new Set<string>();
    const calleeRawCache = new Map<string, string>();
    const getCalleeRaw = (calleePath: string): string => {
      let cached = calleeRawCache.get(calleePath);
      if (cached === undefined) {
        cached = existsSync(calleePath) ? readFileSync(calleePath, 'utf8') : '';
        calleeRawCache.set(calleePath, cached);
      }
      return cached;
    };

    const graphComposableRows = db
      .query(
        `SELECT DISTINCT
           ce.target_name AS via_symbol,
           tf.id AS callee_file_id,
           tf.path AS callee_path,
           he.target_name AS http_target,
           he.line_number,
           he.start_offset,
           he.end_offset,
           he.payload_json
         FROM symbol_edges ce
         JOIN files tf ON tf.id = COALESCE(
           ce.target_file_id,
           (SELECT s.file_id FROM symbols s WHERE s.name = ce.target_name AND s.is_exported = 1 LIMIT 1)
         )
         JOIN symbol_edges he ON he.source_file_id = tf.id AND he.edge_kind = 'outbound_http'
         WHERE ce.source_file_id = ?
           AND ce.edge_kind IN ('calls', 'reads_state')
           AND tf.id != ?
         ORDER BY he.line_number ASC`
      )
      .all(fileRow.id, fileRow.id) as Array<{
      via_symbol: string;
      callee_file_id: number;
      callee_path: string;
      http_target: string;
      line_number: number;
      start_offset: number;
      end_offset: number;
      payload_json: string | null;
    }>;

    for (const row of graphComposableRows) {
      graphCoveredCalls.add(row.via_symbol);
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json) as {
            client?: string;
            url?: string;
            method?: string;
            isDynamicMethod?: boolean;
          })
        : {};
      let method: string;
      if (payload.method) {
        method = payload.method.toUpperCase();
      } else {
        const calleeRaw = getCalleeRaw(row.callee_path);
        method = calleeRaw
          ? extractHttpMethodFromCall(calleeRaw, row.start_offset, row.end_offset)
          : 'GET';
      }
      const url = normalizeHttpUrl(payload.url ?? row.http_target);
      const key = `${method}:${url}:${row.callee_path}:${row.line_number}`;
      if (seenBoundary.has(key)) continue;
      seenBoundary.add(key);
      if (method === 'DYNAMIC' || payload.isDynamicMethod) {
        diagnostics.push({
          code: 'DYNAMIC_HTTP_METHOD',
          message: `HTTP method for "${url}" via ${row.via_symbol} (${row.callee_path}:${row.line_number}) is determined dynamically at runtime.`,
          filePath: row.callee_path,
        });
      }
      outboundHttp.push({
        client: payload.client ?? 'fetch',
        method,
        url,
        filePath: row.callee_path,
        line: row.line_number,
        source: 'composable',
        viaSymbol: row.via_symbol,
      });
    }

    // 2b. Semantic fallback only for called identifiers not already covered by SQLite graph edges
    if (resolveTypes) {
      const doc = defaultPluginRegistry.projectFile(targetFile, rawContent, fileRow.content_hash);
      if (doc) {
        const sf = ts.createSourceFile(
          doc.virtualPath,
          doc.virtualCode,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );
        const calledIdentifiers: Array<{ name: string; origOffset: number }> = [];
        const visitedNames = new Set<string>();
        const collectCalls = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const name = node.expression.text;
            if (
              !visitedNames.has(name) &&
              !graphCoveredCalls.has(name) &&
              !['fetch', '$fetch', 'defineProps', 'defineEmits', 'withDefaults'].includes(name)
            ) {
              const mapped = doc.toOriginalSpan(node.expression.getStart(sf), node.expression.getEnd());
              if (mapped) {
                visitedNames.add(name);
                calledIdentifiers.push({ name, origOffset: mapped.start });
              }
            }
          }
          ts.forEachChild(node, collectCalls);
        };
        collectCalls(sf);

        for (const call of calledIdentifiers) {
          let defs;
          try {
            defs = semanticPool.getDefinitionsAtOffset(absRoot, targetFile, call.origOffset + 1);
          } catch {
            continue;
          }
          for (const def of defs) {
            if (def.filePath === targetFile || def.filePath.endsWith('.d.ts')) continue;
            const calleeFileRow = db
              .query('SELECT id, path FROM files WHERE path = ?')
              .get(def.filePath) as { id: number; path: string } | null;
            if (!calleeFileRow) continue;

            const calleeHttpRows = db
              .query(
                `SELECT target_name, line_number, start_offset, end_offset, payload_json
                 FROM symbol_edges
                 WHERE source_file_id = ? AND edge_kind = 'outbound_http'
                 ORDER BY line_number ASC`
              )
              .all(calleeFileRow.id) as Array<{
              target_name: string;
              line_number: number;
              start_offset: number;
              end_offset: number;
              payload_json: string | null;
            }>;

            if (calleeHttpRows.length === 0) continue;
            for (const row of calleeHttpRows) {
              const payload = row.payload_json
                ? (JSON.parse(row.payload_json) as { client?: string; url?: string; method?: string; isDynamicMethod?: boolean })
                : {};
              let method: string;
              if (payload.method) {
                method = payload.method.toUpperCase();
              } else {
                const calleeRaw = getCalleeRaw(calleeFileRow.path);
                method = calleeRaw
                  ? extractHttpMethodFromCall(calleeRaw, row.start_offset, row.end_offset)
                  : 'GET';
              }
              const url = normalizeHttpUrl(payload.url ?? row.target_name);
              const key = `${method}:${url}:${calleeFileRow.path}:${row.line_number}`;
              if (seenBoundary.has(key)) continue;
              seenBoundary.add(key);
              verification = 'semantic';
              if (method === 'DYNAMIC' || payload.isDynamicMethod) {
                diagnostics.push({
                  code: 'DYNAMIC_HTTP_METHOD',
                  message: `HTTP method for "${url}" via ${call.name} (${calleeFileRow.path}:${row.line_number}) is determined dynamically at runtime.`,
                  filePath: calleeFileRow.path,
                });
              }
              outboundHttp.push({
                client: payload.client ?? 'fetch',
                method,
                url,
                filePath: calleeFileRow.path,
                line: row.line_number,
                source: 'composable',
                viaSymbol: call.name,
              });
            }
          }
        }
      }
    }

    if (outboundHttp.length > 0) {
      const apiRoutes = db
        .query(
          `SELECT r.url_path, r.handlers_json, f.path AS file_path, f.rel_path
           FROM routes r
           JOIN files f ON f.id = r.file_id
           WHERE r.route_type = 'api'`
        )
        .all() as Array<{
        url_path: string;
        handlers_json: string | null;
        file_path: string;
        rel_path: string;
      }>;

      const matchApiRoute = (rawUrl: string, method: string): BoundaryBackendTargetHint | undefined => {
        const cleanUrl = rawUrl.split('?')[0]!.replace(/\/+$/, '') || '/';
        if (!cleanUrl.startsWith('/')) return undefined;
        const upperMethod = method.toUpperCase();

        const matchesMethod = (handlersJson: string | null): boolean => {
          if (upperMethod === 'DYNAMIC') return true;
          if (!handlersJson) return true;
          const handlers = JSON.parse(handlersJson) as string[];
          return handlers.length === 0 || handlers.includes('ALL') || handlers.includes(upperMethod);
        };

        // 1. Exact path match
        for (const r of apiRoutes) {
          const normRoute = r.url_path.replace(/\/+$/, '') || '/';
          if (normRoute === cleanUrl && matchesMethod(r.handlers_json)) {
            return {
              endpoint: r.url_path,
              method: upperMethod,
              filePath: r.file_path,
              relPath: r.rel_path,
            };
          }
        }

        // 2. Parameterized Nitro/Next API route match (e.g. /api/users/[id] or /api/docs/[...slug])
        const urlSegs = cleanUrl.split('/').filter(Boolean);
        for (const r of apiRoutes) {
          if (!matchesMethod(r.handlers_json)) continue;
          const routeSegs = r.url_path.split('/').filter(Boolean);
          const hasCatchAll = routeSegs.some((s) => s.startsWith('[...'));
          if (!hasCatchAll && routeSegs.length !== urlSegs.length) continue;
          let matched = true;
          for (let i = 0; i < routeSegs.length; i++) {
            const rs = routeSegs[i]!;
            if (rs.startsWith('[...')) break;
            if (rs.startsWith('[')) continue;
            if (rs !== urlSegs[i]) {
              matched = false;
              break;
            }
          }
          if (matched) {
            return {
              endpoint: r.url_path,
              method: upperMethod,
              filePath: r.file_path,
              relPath: r.rel_path,
            };
          }
        }
        return undefined;
      };

      for (const item of outboundHttp) {
        const hint = matchApiRoute(item.url, item.method);
        if (hint) item.backendTargetHint = hint;
      }
    }

    data.boundaries = { outboundHttp };
  }

  if (sections.includes('imports')) {
    const impRows = db
      .query(
        `SELECT e.target_name, tf.path AS target_path, e.line_number, e.payload_json
         FROM symbol_edges e
         LEFT JOIN files tf ON tf.id = e.target_file_id
         WHERE e.source_file_id = ? AND e.edge_kind = 'imports'
         ORDER BY e.line_number ASC`
      )
      .all(fileRow.id) as Array<{
      target_name: string;
      target_path: string | null;
      line_number: number;
      payload_json: string | null;
    }>;

    data.imports = impRows.map((r) => {
      const payload = r.payload_json ? (JSON.parse(r.payload_json) as { isTypeOnly?: boolean }) : {};
      return {
        specifier: r.target_name,
        resolvedFilePath: r.target_path,
        isTypeOnly: Boolean(payload.isTypeOnly),
        line: r.line_number,
      };
    });
  }

  return {
    scope: targetFile,
    verification,
    data,
    omissions,
    diagnostics,
  };
}
