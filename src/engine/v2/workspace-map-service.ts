import { canonicalizePath } from '../path-resolver';
import {
  paginateItems,
  type QueryEnvelope,
  type ServiceRuntimeOptions,
} from './contracts';
import { ValidationError } from './errors';
import { syncWorkspaceV3 } from './fast-sync';
import { defaultWarmDbPool } from './schema-v3';

export type WorkspaceMapView = 'overview' | 'packages' | 'routes' | 'files' | 'health';

export interface MapWorkspaceRequest extends ServiceRuntimeOptions {
  workspaceRoot: string;
  view?: WorkspaceMapView;
  packageKey?: string;
  pathPrefix?: string;
  limit?: number;
  cursor?: string;
}

export interface PackageSummaryItem {
  packageKey: string;
  name: string | null;
  framework: string;
  router: string;
  tsconfigPath: string | null;
  fileCount: number;
  symbolCount: number;
  routeCount: number;
  exports: Record<string, string>;
}

export interface RouteSummaryItem {
  packageKey: string;
  urlPath: string;
  filePath: string;
  relPath: string;
  routeType: string;
  renderBoundary: string | null;
  params: string[];
  layouts: string[];
}

export interface FileInventoryItem {
  packageKey: string;
  filePath: string;
  relPath: string;
  framework: string;
  isPage: boolean;
  isLayout: boolean;
  renderBoundary: string | null;
}

export interface HealthCandidateItem {
  packageKey: string;
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  relPath: string;
  line: number;
  reason: string;
  confidence: 'medium' | 'low';
}

export interface WorkspaceMapData {
  view: WorkspaceMapView;
  packages?: PackageSummaryItem[];
  routes?: RouteSummaryItem[];
  files?: FileInventoryItem[];
  health?: {
    unusedComponents: HealthCandidateItem[];
    unusedExports: HealthCandidateItem[];
  };
  totals?: {
    packages: number;
    files: number;
    symbols: number;
    routes: number;
  };
}

const VALID_VIEWS = new Set<WorkspaceMapView>(['overview', 'packages', 'routes', 'files', 'health']);

/**
 * Read-Only Workspace Query Service:
 * Provides workspace orientation (packages, routes, file inventory, and unused candidates) from the SQLite index.
 */
export async function mapWorkspace(
  request: MapWorkspaceRequest
): Promise<QueryEnvelope<WorkspaceMapData>> {
  const view: WorkspaceMapView = request.view ?? 'overview';
  if (!VALID_VIEWS.has(view)) {
    throw new ValidationError(
      `Invalid view "${String(view)}". Expected one of: overview, packages, routes, files, health.`
    );
  }

  const absRoot = canonicalizePath(request.workspaceRoot);
  const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });

  if (!request.skipSync) {
    await syncWorkspaceV3(absRoot, {
      db,
      packageKey: request.packageKey,
    });
  }

  const limit = request.limit ?? 100;
  const scope = request.packageKey ? `${absRoot} (package: ${request.packageKey})` : absRoot;

  if (view === 'overview' || view === 'packages') {
    const rows = db
      .query(
        `SELECT
           p.package_key,
           p.name,
           p.framework,
           p.router,
           p.tsconfig_path,
           p.exports_json,
           (SELECT count(*) FROM files f WHERE f.package_id = p.id) AS file_count,
           (SELECT count(*) FROM symbols s WHERE s.package_id = p.id) AS symbol_count,
           (SELECT count(*) FROM routes r WHERE r.package_id = p.id) AS route_count
         FROM packages p
         WHERE (? IS NULL OR p.package_key = ?)
         ORDER BY p.package_key ASC`
      )
      .all(request.packageKey ?? null, request.packageKey ?? null) as Array<{
      package_key: string;
      name: string | null;
      framework: string;
      router: string;
      tsconfig_path: string | null;
      exports_json: string | null;
      file_count: number;
      symbol_count: number;
      route_count: number;
    }>;

    const allPackages: PackageSummaryItem[] = rows.map((r) => ({
      packageKey: r.package_key,
      name: r.name,
      framework: r.framework,
      router: r.router,
      tsconfigPath: r.tsconfig_path,
      fileCount: r.file_count,
      symbolCount: r.symbol_count,
      routeCount: r.route_count,
      exports: r.exports_json ? (JSON.parse(r.exports_json) as Record<string, string>) : {},
    }));

    const totals = allPackages.reduce(
      (acc, p) => ({
        packages: acc.packages + 1,
        files: acc.files + p.fileCount,
        symbols: acc.symbols + p.symbolCount,
        routes: acc.routes + p.routeCount,
      }),
      { packages: 0, files: 0, symbols: 0, routes: 0 }
    );

    const { page, pagination } = paginateItems(allPackages, limit, request.cursor);

    return {
      scope,
      verification: 'graph',
      data: {
        view,
        packages: page,
        totals,
      },
      pagination,
      omissions: [],
      diagnostics: [],
    };
  }

  if (view === 'routes') {
    const rows = db
      .query(
        `SELECT
           p.package_key,
           r.url_path,
           f.path AS file_path,
           f.rel_path,
           r.route_type,
           f.render_boundary,
           r.params_json,
           r.layout_chain_json
         FROM routes r
         JOIN packages p ON p.id = r.package_id
         JOIN files f ON f.id = r.file_id
         WHERE (? IS NULL OR p.package_key = ?)
         ORDER BY p.package_key ASC, r.url_path ASC`
      )
      .all(request.packageKey ?? null, request.packageKey ?? null) as Array<{
      package_key: string;
      url_path: string;
      file_path: string;
      rel_path: string;
      route_type: string;
      render_boundary: string | null;
      params_json: string | null;
      layout_chain_json: string | null;
    }>;

    const items: RouteSummaryItem[] = rows.map((r) => ({
      packageKey: r.package_key,
      urlPath: r.url_path,
      filePath: r.file_path,
      relPath: r.rel_path,
      routeType: r.route_type,
      renderBoundary: r.render_boundary,
      params: r.params_json ? (JSON.parse(r.params_json) as string[]) : [],
      layouts: r.layout_chain_json ? (JSON.parse(r.layout_chain_json) as string[]) : [],
    }));

    const { page, pagination } = paginateItems(items, limit, request.cursor);

    return {
      scope,
      verification: 'graph',
      data: { view, routes: page },
      pagination,
      omissions: [],
      diagnostics: [],
    };
  }

  if (view === 'files') {
    const prefix = request.pathPrefix ? request.pathPrefix.replace(/\\/g, '/').replace(/^\/+/, '') : null;
    const rows = db
      .query(
        `SELECT
           p.package_key,
           f.path AS file_path,
           f.rel_path,
           f.framework,
           f.is_page,
           f.is_layout,
           f.render_boundary
         FROM files f
         JOIN packages p ON p.id = f.package_id
         WHERE (? IS NULL OR p.package_key = ?)
           AND (? IS NULL OR f.rel_path LIKE ? || '%')
         ORDER BY p.package_key ASC, f.rel_path ASC`
      )
      .all(
        request.packageKey ?? null,
        request.packageKey ?? null,
        prefix,
        prefix
      ) as Array<{
      package_key: string;
      file_path: string;
      rel_path: string;
      framework: string;
      is_page: number;
      is_layout: number;
      render_boundary: string | null;
    }>;

    const items: FileInventoryItem[] = rows.map((r) => ({
      packageKey: r.package_key,
      filePath: r.file_path,
      relPath: r.rel_path,
      framework: r.framework,
      isPage: r.is_page === 1,
      isLayout: r.is_layout === 1,
      renderBoundary: r.render_boundary,
    }));

    const { page, pagination } = paginateItems(items, limit, request.cursor);

    return {
      scope,
      verification: 'graph',
      data: { view, files: page },
      pagination,
      omissions: [],
      diagnostics: [],
    };
  }

  // view === 'health': candidate unused non-page/non-layout components
  const unusedCompRows = db
    .query(
      `SELECT
         p.package_key,
         s.symbol_uid,
         s.name,
         s.kind,
         f.path AS file_path,
         f.rel_path,
         s.start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN packages p ON p.id = s.package_id
       WHERE s.kind = 'component'
         AND f.is_page = 0
         AND f.is_layout = 0
         AND (? IS NULL OR p.package_key = ?)
         AND NOT EXISTS (
           SELECT 1 FROM symbol_edges e
           WHERE (e.target_file_id = f.id OR e.target_name = s.name)
             AND e.source_file_id != f.id
             AND e.edge_kind IN ('imports', 'reexports', 'renders')
         )
       ORDER BY p.package_key ASC, f.rel_path ASC`
    )
    .all(request.packageKey ?? null, request.packageKey ?? null) as Array<{
    package_key: string;
    symbol_uid: string;
    name: string;
    kind: string;
    file_path: string;
    rel_path: string;
    start_line: number;
  }>;

  const unusedComponents: HealthCandidateItem[] = unusedCompRows.map((r) => ({
    packageKey: r.package_key,
    symbolId: r.symbol_uid,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    relPath: r.rel_path,
    line: r.start_line,
    reason: 'No static import, re-export, or render edge found across indexed workspace files.',
    confidence: 'medium',
  }));

  return {
    scope,
    verification: 'graph',
    data: {
      view,
      health: {
        unusedComponents: unusedComponents.slice(0, limit),
        unusedExports: [],
      },
    },
    omissions: [],
    diagnostics: [
      {
        code: 'STATIC_CANDIDATE_ONLY',
        message: 'Health candidates reflect static graph edges; dynamically registered or externally consumed components require manual confirmation.',
      },
    ],
  };
}
