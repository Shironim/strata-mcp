import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import {
  detectFramework,
  extractComponentContract,
  extractRenderBoundary,
  extractStateDependencies,
} from './contract';
import { extractLocalImports, isPageFile } from './tree';
import { escapeRegExp } from './patterns';
import { scanRoutes } from './routes';
import type {
  QueryStateImpactOptions,
  StateChainNode,
  StateChainResult,
  StateImpactConsumer,
  StateImpactResult,
  SyncStats,
  TraceStateChainOptions,
  UnusedStateItem,
  UnusedStateResult,
} from '../types';

const SUPPORTED_EXTENSIONS = new Set(['.vue', '.astro', '.tsx', '.jsx', '.ts', '.js']);

/**
 * Checks if a file path represents a layout file.
 */
export function isLayoutFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(norm).toLowerCase();
  return (
    base.startsWith('layout.') ||
    norm.includes('/layouts/') ||
    norm.includes('/Layouts/') ||
    base.includes('layout')
  );
}

/**
 * Opens or initializes a SQLite database for the workspace with WAL mode.
 */
export function getWorkspaceDatabase(workspaceRoot: string): Database {
  const absRoot = resolve(workspaceRoot);
  const dbDir = join(absRoot, '.strata');

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    // Write a .gitignore inside .strata so cache DB is never checked into Git
    try {
      writeFileSync(join(dbDir, '.gitignore'), '*\n');
    } catch {
      // ignore
    }
  }

  const dbPath = join(dbDir, 'graph.db');
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode & foreign keys for high-concurrency performance
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');

  initSchema(db);
  return db;
}

/**
 * Initializes table schemas and indexes if they do not exist.
 */
function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      framework TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      is_page INTEGER DEFAULT 0,
      is_layout INTEGER DEFAULT 0,
      render_boundary TEXT,
      boundary_directive TEXT
    );

    CREATE TABLE IF NOT EXISTS components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      contract_json TEXT,
      UNIQUE(file_id, name)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      child_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      import_type TEXT NOT NULL,
      is_rendered INTEGER DEFAULT 1,
      UNIQUE(parent_file_id, child_file_id, import_type)
    );

    CREATE TABLE IF NOT EXISTS state_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      identifier TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_path TEXT UNIQUE NOT NULL,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      params_json TEXT,
      handlers_json TEXT,
      layout_chain_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
    CREATE INDEX IF NOT EXISTS idx_edges_parent ON edges(parent_file_id);
    CREATE INDEX IF NOT EXISTS idx_edges_child ON edges(child_file_id);
    CREATE INDEX IF NOT EXISTS idx_state_deps_identifier ON state_deps(identifier);
    CREATE INDEX IF NOT EXISTS idx_routes_url ON routes(url_path);
  `);
}

export interface WorkspaceDelta {
  diskMap: Map<string, { fullPath: string; mtime: number; size: number }>;
  dbMap: Map<string, { id: number; mtime: number; size: number }>;
  added: string[];
  modified: string[];
  deleted: number[];
  unchanged: number;
}

export interface ParsedFilePayload {
  path: string;
  framework: string;
  boundary: { boundary: string; directive?: string };
  stateDeps: { stores: string[]; contexts: string[]; composables: string[] };
  compName: string;
  contract: any;
  edges: Array<{ targetPath: string; isDynamic: boolean }>;
}

export interface ParsedWorkspaceBatch {
  files: Map<string, ParsedFilePayload>;
  routes: Awaited<ReturnType<typeof scanRoutes>> | null;
}

/**
 * 1. Gathers disk candidate files and calculates the delta against SQLite.
 */
export async function hashChecker(
  absRoot: string,
  db: Database,
  scopePath?: string
): Promise<WorkspaceDelta> {
  const scanTarget = scopePath ? resolve(absRoot, scopePath) : absRoot;
  const allDiskFiles = await collectFiles(scanTarget);
  const candidateFiles = allDiskFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    const norm = f.replace(/\\/g, '/');
    return (
      SUPPORTED_EXTENSIONS.has(ext) &&
      !norm.includes('/.strata/') &&
      !norm.includes('/.vue-ast/') &&
      !norm.includes('/node_modules/') &&
      !norm.includes('/vendor/') &&
      !norm.includes('/dist/') &&
      !norm.includes('/public/build/') &&
      !norm.includes('/.git/')
    );
  });

  const diskMap = new Map<string, { fullPath: string; mtime: number; size: number }>();
  for (const f of candidateFiles) {
    try {
      const st = await fs.stat(f);
      const norm = normalize(f);
      diskMap.set(norm, {
        fullPath: f,
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
      });
    } catch {
      // ignore unreadable
    }
  }

  const dbFiles = db.query('SELECT id, path, mtime, size FROM files').all() as Array<{
    id: number;
    path: string;
    mtime: number;
    size: number;
  }>;

  const dbMap = new Map<string, { id: number; mtime: number; size: number }>();
  for (const row of dbFiles) {
    dbMap.set(row.path, { id: row.id, mtime: row.mtime, size: row.size });
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: number[] = [];
  let unchanged = 0;

  for (const [path, diskInfo] of diskMap.entries()) {
    const inDb = dbMap.get(path);
    if (!inDb) {
      added.push(path);
    } else if (inDb.mtime !== diskInfo.mtime || inDb.size !== diskInfo.size) {
      modified.push(path);
    } else {
      unchanged++;
    }
  }

  const normScanTarget = normalize(scanTarget);
  for (const [path, dbInfo] of dbMap.entries()) {
    // If scopePath is provided, only mark deletion for files residing within scopePath
    if (scopePath && !path.startsWith(normScanTarget)) {
      continue;
    }
    if (!diskMap.has(path)) {
      deleted.push(dbInfo.id);
    }
  }

  return {
    diskMap,
    dbMap,
    added,
    modified,
    deleted,
    unchanged,
  };
}

/**
 * 2. Parses changed/added files in-memory for contracts, boundaries, state dependencies, and edges.
 */
export async function batchParser(
  toProcess: string[],
  absRoot: string,
  diskMap: Map<string, { fullPath: string; mtime: number; size: number }>
): Promise<ParsedWorkspaceBatch> {
  const parsedFiles = new Map<string, ParsedFilePayload>();

  for (const path of toProcess) {
    try {
      const content = await fs.readFile(path, 'utf8');
      const framework = detectFramework(path);
      const boundary = extractRenderBoundary(path, content, framework);
      const stateDeps = extractStateDependencies(content, framework);
      const compName = basename(path, extname(path));
      const contract = await extractComponentContract(path, content);
      const allImports = extractLocalImports(content);

      const edges: Array<{ targetPath: string; isDynamic: boolean }> = [];
      for (const imp of allImports) {
        if (imp.source.startsWith('.')) {
          const targetCandidate = resolve(dirname(path), imp.source);
          let matchedPath: string | undefined;

          for (const ext of ['', '.vue', '.tsx', '.jsx', '.ts', '.js', '/index.ts', '/index.vue']) {
            const testP = normalize(targetCandidate + ext);
            if (diskMap.has(testP)) {
              matchedPath = testP;
              break;
            }
          }

          if (matchedPath) {
            edges.push({
              targetPath: matchedPath,
              isDynamic: imp.isDynamic ?? false,
            });
          }
        }
      }

      parsedFiles.set(path, {
        path,
        framework,
        boundary,
        stateDeps,
        compName,
        contract,
        edges,
      });
    } catch {
      // ignore parse failures
    }
  }

  let routeManifest: Awaited<ReturnType<typeof scanRoutes>> | null = null;
  try {
    const manifest = await scanRoutes({ targetPath: absRoot });
    if (manifest.routes.length > 0) {
      routeManifest = manifest;
    }
  } catch {
    // ignore route scan failures
  }

  return {
    files: parsedFiles,
    routes: routeManifest,
  };
}

/**
 * 3. Commits file delta, parsed components, edges, state dependencies, and routes in an atomic SQLite transaction.
 */
export function transactionCommitter(
  db: Database,
  delta: WorkspaceDelta,
  parsedBatch: ParsedWorkspaceBatch,
  startTime: number
): SyncStats {
  const insertFileStmt = db.prepare(`
    INSERT INTO files (path, framework, mtime, size, is_page, is_layout, render_boundary, boundary_directive)
    VALUES ($path, $framework, $mtime, $size, $is_page, $is_layout, $render_boundary, $boundary_directive)
    RETURNING id;
  `);

  const updateFileStmt = db.prepare(`
    UPDATE files
    SET framework = $framework, mtime = $mtime, size = $size, is_page = $is_page,
        is_layout = $is_layout, render_boundary = $render_boundary, boundary_directive = $boundary_directive
    WHERE id = $id;
  `);

  const insertComponentStmt = db.prepare(`
    INSERT OR REPLACE INTO components (file_id, name, contract_json)
    VALUES ($file_id, $name, $contract_json);
  `);

  const insertEdgeStmt = db.prepare(`
    INSERT OR IGNORE INTO edges (parent_file_id, child_file_id, import_type, is_rendered)
    VALUES ($parent_file_id, $child_file_id, $import_type, $is_rendered);
  `);

  const insertStateDepStmt = db.prepare(`
    INSERT INTO state_deps (file_id, kind, identifier)
    VALUES ($file_id, $kind, $identifier);
  `);

  const deleteFileStmt = db.prepare(`DELETE FROM files WHERE id = ?;`);
  const cleanRelationsStmt = db.prepare(`
    DELETE FROM components WHERE file_id = $id;
    DELETE FROM edges WHERE parent_file_id = $id;
    DELETE FROM state_deps WHERE file_id = $id;
  `);

  const toProcess = [...delta.added, ...delta.modified];
  const fileIdMap = new Map<string, number>();

  for (const [path, info] of delta.dbMap.entries()) {
    fileIdMap.set(path, info.id);
  }

  const transaction = db.transaction(() => {
    // A. Delete vanished files
    for (const delId of delta.deleted) {
      deleteFileStmt.run(delId);
    }

    // B. Process added and modified files
    for (const path of toProcess) {
      const diskInfo = delta.diskMap.get(path);
      if (!diskInfo) continue;

      const parsed = parsedBatch.files.get(path);
      const framework = parsed?.framework || detectFramework(path);
      const isPage = isPageFile(path) ? 1 : 0;
      const isLayout = isLayoutFile(path) ? 1 : 0;
      const renderBoundary = parsed?.boundary.boundary || null;
      const boundaryDirective = parsed?.boundary.directive || null;

      let fileId: number;
      if (delta.modified.includes(path) && delta.dbMap.has(path)) {
        fileId = delta.dbMap.get(path)!.id;
        updateFileStmt.run({
          $id: fileId,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: renderBoundary,
          $boundary_directive: boundaryDirective,
        });
        cleanRelationsStmt.run({ $id: fileId });
      } else {
        const res = insertFileStmt.get({
          $path: path,
          $framework: framework,
          $mtime: diskInfo.mtime,
          $size: diskInfo.size,
          $is_page: isPage,
          $is_layout: isLayout,
          $render_boundary: renderBoundary,
          $boundary_directive: boundaryDirective,
        }) as { id: number };
        fileId = res.id;
      }

      fileIdMap.set(path, fileId);
    }

    // C. Insert parsed components, state deps, and edges
    for (const parsed of parsedBatch.files.values()) {
      const fileId = fileIdMap.get(parsed.path);
      if (!fileId) continue;

      insertComponentStmt.run({
        $file_id: fileId,
        $name: parsed.compName,
        $contract_json: JSON.stringify(parsed.contract),
      });

      for (const st of parsed.stateDeps.stores) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'store', $identifier: st });
      }
      for (const ctx of parsed.stateDeps.contexts) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'context', $identifier: ctx });
      }
      for (const cmp of parsed.stateDeps.composables) {
        insertStateDepStmt.run({ $file_id: fileId, $kind: 'composable', $identifier: cmp });
      }

      for (const edge of parsed.edges) {
        const childId = fileIdMap.get(edge.targetPath);
        if (childId) {
          insertEdgeStmt.run({
            $parent_file_id: fileId,
            $child_file_id: childId,
            $import_type: edge.isDynamic ? 'dynamic' : 'static',
            $is_rendered: 1,
          });
        }
      }
    }

    // D. Sync routes table
    if (parsedBatch.routes && parsedBatch.routes.routes.length > 0) {
      db.run('DELETE FROM routes;');
      const insertRouteStmt = db.prepare(`
        INSERT OR REPLACE INTO routes (url_path, file_id, type, params_json, handlers_json, layout_chain_json)
        VALUES ($url_path, $file_id, $type, $params_json, $handlers_json, $layout_chain_json);
      `);

      for (const r of parsedBatch.routes.routes) {
        const fId = fileIdMap.get(normalize(r.filePath));
        if (fId) {
          insertRouteStmt.run({
            $url_path: r.path,
            $file_id: fId,
            $type: r.type,
            $params_json: JSON.stringify(r.params),
            $handlers_json: r.handlers ? JSON.stringify(r.handlers) : null,
            $layout_chain_json: r.layouts ? JSON.stringify(r.layouts) : null,
          });
        }
      }
    }
  });

  transaction();

  return {
    added: delta.added.length,
    modified: delta.modified.length,
    deleted: delta.deleted.length,
    unchanged: delta.unchanged,
    total: delta.diskMap.size,
    durationMs: Math.round(performance.now() - startTime),
  };
}

/**
 * Synchronizes the workspace disk state with SQLite using file mtime (Smart Delta Sync).
 * Orchestrates: hashChecker -> batchParser -> transactionCommitter.
 */
export async function syncWorkspace(
  workspaceRoot: string,
  scopePath?: string
): Promise<SyncStats> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  const db = getWorkspaceDatabase(absRoot);

  // 1. Gather files and detect delta
  const delta = await hashChecker(absRoot, db, scopePath);

  // Fast exit if nothing changed
  if (delta.added.length === 0 && delta.modified.length === 0 && delta.deleted.length === 0) {
    return {
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: delta.unchanged,
      total: delta.diskMap.size,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  // 2. Batch parse modified/added files
  const toProcess = [...delta.added, ...delta.modified];
  const parsedBatch = await batchParser(toProcess, absRoot, delta.diskMap);

  // 3. Commit all changes inside SQLite transaction
  return transactionCommitter(db, delta, parsedBatch, startTime);
}


/**
 * Analyzes consumer source code to classify whether it mutates state/calls actions
 * or merely reads/watches/renders state.
 */
async function classifyConsumerRole(
  absPath: string,
  identifier: string
): Promise<{ role: 'mutator' | 'reader'; actionsCalled?: string[]; snippet?: string }> {
  try {
    const content = await fs.readFile(absPath, 'utf8');

    const actionKeywords = [
      'confirm',
      'handle',
      'submit',
      'set',
      'update',
      'delete',
      'add',
      'remove',
      'open',
      'close',
      'mutate',
      'trigger',
      'run',
      'toggle',
      'reset',
      'dispatch',
      'post',
      'put',
      'patch',
      'reload',
      'visit',
      'revalidate',
      'refresh',
    ];

    const callNames: string[] = [];

    // 1. Destructured call: const { confirmDelete, isConfirmOpen } = useConfirm()
    const destructureRegex = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escapeRegExp(identifier)}\\s*\\(`,
      'g'
    );
    for (const match of content.matchAll(destructureRegex)) {
      const vars = match[1]
        .split(',')
        .map((v) => v.trim().split(':')[0].trim())
        .filter(Boolean);
      for (const v of vars) {
        const isActionName = actionKeywords.some((kw) =>
          v.toLowerCase().startsWith(kw) || v.toLowerCase().includes(kw)
        );
        const isInvoked = new RegExp(`\\b${escapeRegExp(v)}\\s*\\(`).test(content);
        if (isActionName || isInvoked) {
          callNames.push(`${v}()`);
        }
      }
    }

    // 2. Instance variable call: const confirm = useConfirm(); confirm.open(...) or const form = useForm(...)
    const instanceRegex = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*${escapeRegExp(identifier)}\\s*\\(`,
      'g'
    );
    for (const match of content.matchAll(instanceRegex)) {
      const instName = match[1];
      const methodCalls = content.matchAll(
        new RegExp(`\\b${escapeRegExp(instName)}\\.([A-Za-z0-9_$]+)\\s*\\(`, 'g')
      );
      for (const mc of methodCalls) {
        callNames.push(`${instName}.${mc[1]}()`);
      }
    }

    // 3. Direct router or $inertia global call: router.post(...), router.reload(...)
    if (identifier === 'router' || identifier === '$inertia') {
      const routerCalls = content.matchAll(
        new RegExp(`\\b${escapeRegExp(identifier)}\\.([A-Za-z0-9_$]+)\\s*\\(`, 'g')
      );
      for (const rc of routerCalls) {
        callNames.push(`${identifier}.${rc[1]}()`);
      }
    }

    // 4. Direct chained call: useConfirm().confirm(...)
    const directChained = content.matchAll(
      new RegExp(`\\b${escapeRegExp(identifier)}\\s*\\([^)]*\\)\\.([A-Za-z0-9_$]+)\\s*\\(`, 'g')
    );
    for (const dc of directChained) {
      callNames.push(`${dc[1]}()`);
    }

    // 4. Inferred action calls matching identifier naming conventions
    if (callNames.length > 0) {
      const uniqueCalls = Array.from(new Set(callNames));
      return {
        role: 'mutator',
        actionsCalled: uniqueCalls,
        snippet: uniqueCalls.slice(0, 3).join(', '),
      };
    }

    // Check if renders dialog or watches modal visibility
    const rendersDialog =
      /<(?:App)?(?:[A-Za-z0-9_]+)?(?:Confirm|Modal|Dialog|Drawer|Toast)/i.test(content) &&
      content.includes(identifier);

    if (rendersDialog || /is[A-Z][A-Za-z0-9_]+(?:Open|Visible|Active|Loading)/.test(content)) {
      return {
        role: 'reader',
        snippet: 'renders dialog / watches visibility state',
      };
    }

    return {
      role: 'reader',
      snippet: 'consumes state values / reactive refs',
    };
  } catch {
    return { role: 'reader' };
  }
}

/**
 * Queries the impact of a state dependency (store, context, composable) across all files in SQLite.
 * Categorizes consumers into Mutators (triggers/actions) and Readers (renderers/watchers).
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
    SELECT DISTINCT f.path, f.is_page, f.render_boundary, s.kind, s.identifier
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
  }>;

  const consumers: StateImpactConsumer[] = await Promise.all(
    rows.map(async (r) => {
      const classification = await classifyConsumerRole(r.path, identifier);
      return {
        path: r.path,
        isPage: r.is_page === 1,
        renderBoundary: r.render_boundary || undefined,
        kind: r.kind,
        identifier: r.identifier,
        role: classification.role,
        actionsCalled: classification.actionsCalled,
        usageSnippet: classification.snippet,
      };
    })
  );

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

export interface UpwardBlastRadiusNode {
  path: string;
  framework: string;
  isPage: boolean;
  depth: number;
}

/**
 * Queries the upward blast radius (consumers up to pages) using SQLite Recursive CTE.
 */
export function queryUpwardBlastRadiusFromDb(
  db: Database,
  targetPath: string,
  maxDepth: number = 5
): UpwardBlastRadiusNode[] {
  const normTarget = normalize(targetPath);
  const target = db
    .query('SELECT id FROM files WHERE path = ?')
    .get(normTarget) as { id: number } | null;
  if (!target) return [];

  const rows = db
    .query(
      `
    WITH RECURSIVE blast_radius(file_id, depth) AS (
      SELECT parent_file_id, 1 FROM edges WHERE child_file_id = ?
      UNION
      SELECT e.parent_file_id, b.depth + 1
      FROM edges e JOIN blast_radius b ON e.child_file_id = b.file_id
      WHERE b.depth < ?
    )
    SELECT DISTINCT f.path, f.framework, f.is_page, b.depth
    FROM blast_radius b
    JOIN files f ON b.file_id = f.id
    ORDER BY b.depth ASC, f.is_page DESC;
  `
    )
    .all(target.id, maxDepth) as Array<{
    path: string;
    framework: string;
    is_page: number;
    depth: number;
  }>;

  return rows.map((r) => ({
    path: r.path,
    framework: r.framework,
    isPage: r.is_page === 1,
    depth: r.depth,
  }));
}

/**
 * Queries unused/orphan components directly using an SQL anti-join.
 */
export function queryUnusedComponentsFromDb(
  db: Database
): Array<{ name: string; path: string; framework: string }> {
  const rows = db
    .query(
      `
    SELECT c.name, f.path, f.framework
    FROM components c
    JOIN files f ON c.file_id = f.id
    LEFT JOIN edges e ON c.file_id = e.child_file_id
    WHERE e.child_file_id IS NULL AND f.is_page = 0 AND f.is_layout = 0
    ORDER BY c.name ASC;
  `
    )
    .all() as Array<{ name: string; path: string; framework: string }>;

  return rows;
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

