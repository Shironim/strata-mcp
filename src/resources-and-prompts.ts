import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { collectFilesWithReport } from './engine/collector';
import { DEFAULT_RESPONSE_BUDGET_BYTES } from './engine/context-budget';
import { extractComponentContract } from './engine/contract';
import { mapFrontendScope } from './engine/frontend-map';
import { getLastKnownProjectRoot } from './engine/path-resolver';
import { detectRouteFramework } from './engine/routes';
import { openReadonlyIndex, resolveIndexedWorkspaceRoot } from './engine/storage/schema';
import { findWorkflowPlaybook, WORKFLOW_PLAYBOOKS } from './workflow-playbooks';

const COMPONENT_EXTENSIONS = new Set(['.vue', '.svelte', '.astro', '.tsx', '.jsx']);
const MAX_COMPONENTS_INDEX = 150;
const MAX_COMPONENT_MATCHES = 5;
const KNOWN_STATE_PACKAGES = [
  'pinia',
  'vuex',
  'redux',
  '@reduxjs/toolkit',
  'zustand',
  'jotai',
  'recoil',
  'mobx',
  'xstate',
  '@tanstack/react-query',
  'swr',
] as const;

export const STRATA_RESOURCES = [
  {
    uri: 'strata://project/overview',
    name: 'Strata Project Overview',
    description:
      'Detected frameworks, router, state managers, .strata/graph.db index status, and file/component/route counts for the active workspace.',
    mimeType: 'application/json',
  },
  {
    uri: 'strata://components/index',
    name: 'Strata Components Index',
    description:
      'Bounded list of discovered frontend components and their workspace-relative file paths without source bodies.',
    mimeType: 'application/json',
  },
] as const;

export const STRATA_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'strata://component/{name}',
    name: 'Strata Component Contract',
    description:
      'Read-only component contract summary (props, emits, slots, models, external state, outbound APIs) for a specific component name.',
    mimeType: 'application/json',
  },
] as const;

export const STRATA_PROMPTS = WORKFLOW_PLAYBOOKS.map(({ name, title, description, arguments: args }) => ({
  name,
  title,
  description,
  arguments: args,
}));

export function listStrataResources() {
  return { resources: [...STRATA_RESOURCES] };
}

export function listStrataResourceTemplates() {
  return { resourceTemplates: [...STRATA_RESOURCE_TEMPLATES] };
}

export function listStrataPrompts() {
  return { prompts: [...STRATA_PROMPTS] };
}

function resolveWorkspaceRoot(explicitRoot?: string): string {
  const candidate = explicitRoot?.trim() || getLastKnownProjectRoot() || process.cwd();
  return resolve(candidate);
}

function openReadonlyGraphDb(workspaceRoot: string): { db: Database; indexedRoot: string } | null {
  const indexedRoot = resolveIndexedWorkspaceRoot(workspaceRoot);
  if (!indexedRoot) return null;
  const dbPath = join(indexedRoot, '.strata', 'graph.db');
  if (!existsSync(dbPath)) return null;
  try {
    return {
      db: openReadonlyIndex(dbPath),
      indexedRoot,
    };
  } catch {
    return null;
  }
}

function detectStateManagersFromPackageJson(workspaceRoot: string): string[] {
  const pkgPath = join(workspaceRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return KNOWN_STATE_PACKAGES.filter((name) => Boolean(allDeps[name]));
  } catch {
    return [];
  }
}

function isComponentFile(filePath: string): boolean {
  return COMPONENT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function stripExtension(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function toPosixRelative(root: string, targetPath: string): string {
  const rel = relative(root, targetPath).replace(/\\/g, '/');
  return rel || basename(targetPath);
}

function serializeBoundedJson(
  buildPayload: (limit: number) => Record<string, unknown>,
  initialCount: number
): string {
  let limit = initialCount;
  while (limit >= 0) {
    const serialized = JSON.stringify(buildPayload(limit), null, 2);
    if (Buffer.byteLength(serialized, 'utf8') <= DEFAULT_RESPONSE_BUDGET_BYTES || limit === 0) {
      return serialized;
    }
    limit = Math.floor(limit * 0.7);
  }
  return JSON.stringify(buildPayload(0), null, 2);
}

async function buildProjectOverviewJson(workspaceRoot: string): Promise<string> {
  const dbHandle = openReadonlyGraphDb(workspaceRoot);
  const stateManagers = new Set<string>(detectStateManagersFromPackageJson(workspaceRoot));
  const [routeInfo, mapResult] = await Promise.all([
    detectRouteFramework(workspaceRoot).catch(() => ({ framework: 'unknown' as const, baseDir: workspaceRoot })),
    mapFrontendScope(workspaceRoot, { limit: 1 }).catch(() => null),
  ]);

  let indexedCounts: { files: number; components: number; routes: number; stateDeps: number } | null = null;
  let dbFrameworks: string[] = [];

  if (dbHandle) {
    try {
      const { db } = dbHandle;
      const countRow = (table: string) =>
        (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | null)?.c ?? 0;
      indexedCounts = {
        files: countRow('files'),
        components: countRow('components'),
        routes: countRow('routes'),
        stateDeps: countRow('state_deps'),
      };
      const fwRows = db.query('SELECT DISTINCT framework FROM files WHERE framework IS NOT NULL').all() as Array<{
        framework: string;
      }>;
      dbFrameworks = fwRows.map((r) => r.framework).filter((fw) => fw && fw !== 'unknown');
      const stateRows = db
        .query("SELECT DISTINCT kind FROM state_deps WHERE kind IS NOT NULL LIMIT 20")
        .all() as Array<{ kind: string }>;
      for (const row of stateRows) {
        if (row.kind) stateManagers.add(row.kind);
      }
    } catch {
      // Keep fallback counts if readonly DB lacks expected tables
    } finally {
      dbHandle.db.close();
    }
  }

  const detectedFrameworks = Array.from(
    new Set([
      ...(mapResult?.frameworkCandidates.map((f) => f.name) ?? []),
      ...dbFrameworks,
    ])
  );

  const payload = {
    workspaceRoot,
    indexed: Boolean(dbHandle && indexedCounts),
    indexStatus: dbHandle && indexedCounts ? 'indexed' : 'not_indexed',
    frameworks: detectedFrameworks,
    router: routeInfo.framework,
    stateManagers: Array.from(stateManagers),
    counts: indexedCounts ?? {
      files: mapResult?.coverage.knownFiles ?? 0,
      components: null,
      routes: null,
      stateDeps: null,
    },
    ...(dbHandle
      ? {}
      : {
          guidance:
            "Workspace has not been indexed yet. Run 'strata init' to enable graph-backed trace_state and dead-state audits.",
        }),
  };

  return JSON.stringify(payload, null, 2);
}

async function buildComponentsIndexJson(workspaceRoot: string): Promise<string> {
  interface ComponentIndexEntry {
    name: string;
    path: string;
    framework?: string;
    isPage?: boolean;
    isLayout?: boolean;
  }

  const dbHandle = openReadonlyGraphDb(workspaceRoot);
  let allEntries: ComponentIndexEntry[] = [];
  let basis: 'indexed' | 'source-fallback' = 'source-fallback';

  if (dbHandle) {
    try {
      const rows = dbHandle.db
        .query(
          `SELECT c.name AS name, f.path AS path, f.framework AS framework, f.is_page AS is_page, f.is_layout AS is_layout
           FROM components c
           JOIN files f ON f.id = c.file_id
           ORDER BY c.name ASC, f.path ASC
           LIMIT ?`
        )
        .all(MAX_COMPONENTS_INDEX + 1) as Array<{
        name: string;
        path: string;
        framework: string;
        is_page: number;
        is_layout: number;
      }>;
      basis = 'indexed';
      allEntries = rows.map((row) => ({
        name: row.name,
        path: toPosixRelative(workspaceRoot, row.path),
        framework: row.framework,
        ...(row.is_page ? { isPage: true } : {}),
        ...(row.is_layout ? { isLayout: true } : {}),
      }));
    } catch {
      allEntries = [];
    } finally {
      dbHandle.db.close();
    }
  }

  if (basis === 'source-fallback') {
    const collected = await collectFilesWithReport(workspaceRoot);
    const componentFiles = collected.files.filter(isComponentFile).sort();
    allEntries = componentFiles.slice(0, MAX_COMPONENTS_INDEX + 1).map((filePath) => ({
      name: stripExtension(filePath),
      path: toPosixRelative(workspaceRoot, filePath),
    }));
  }

  const hasMoreThanCap = allEntries.length > MAX_COMPONENTS_INDEX;
  const capped = allEntries.slice(0, MAX_COMPONENTS_INDEX);

  return serializeBoundedJson(
    (limit) => {
      const sliced = capped.slice(0, limit);
      return {
        workspaceRoot,
        basis,
        totalReturned: sliced.length,
        truncated: hasMoreThanCap || sliced.length < capped.length,
        components: sliced,
      };
    },
    capped.length
  );
}

async function buildComponentDetailJson(workspaceRoot: string, rawName: string): Promise<string> {
  const query = decodeURIComponent(rawName).trim();
  if (!query) {
    throw new Error('Component name in strata://component/{name} must not be empty.');
  }

  const dbHandle = openReadonlyGraphDb(workspaceRoot);
  let candidatePaths: string[] = [];

  if (dbHandle) {
    try {
      const rows = dbHandle.db
        .query(
          `SELECT f.path AS path
           FROM components c
           JOIN files f ON f.id = c.file_id
           WHERE LOWER(c.name) = LOWER(?)
           ORDER BY f.path ASC
           LIMIT ?`
        )
        .all(query, MAX_COMPONENT_MATCHES) as Array<{ path: string }>;
      candidatePaths = rows.map((r) => r.path).filter((p) => existsSync(p));
    } catch {
      candidatePaths = [];
    } finally {
      dbHandle.db.close();
    }
  }

  if (candidatePaths.length === 0) {
    const collected = await collectFilesWithReport(workspaceRoot);
    const lowerQuery = query.toLowerCase();
    candidatePaths = collected.files
      .filter((filePath) => isComponentFile(filePath) && stripExtension(filePath).toLowerCase() === lowerQuery)
      .sort()
      .slice(0, MAX_COMPONENT_MATCHES);
  }

  if (candidatePaths.length === 0) {
    return JSON.stringify(
      {
        workspaceRoot,
        query,
        found: false,
        matches: [],
        suggestion: 'Check strata://components/index or use find_code to locate the component file.',
      },
      null,
      2
    );
  }

  const contracts = await Promise.all(
    candidatePaths.map(async (filePath) => {
      const contract = await extractComponentContract(filePath, { workspaceRoot });
      return {
        name: contract.component || stripExtension(filePath),
        path: toPosixRelative(workspaceRoot, filePath),
        framework: contract.framework,
        props: contract.props,
        emits: contract.emits,
        slots: contract.slots,
        models: contract.models,
        stateDependencies: contract.stateDependencies,
        dataDependencies: contract.dataDependencies,
      };
    })
  );

  return serializeBoundedJson(
    (limit) => {
      const sliced = contracts.slice(0, limit);
      return {
        workspaceRoot,
        query,
        found: true,
        truncated: sliced.length < contracts.length,
        matches: sliced,
      };
    },
    contracts.length
  );
}

export async function readStrataResource(uri: string, explicitRoot?: string) {
  const workspaceRoot = resolveWorkspaceRoot(explicitRoot);

  if (uri === 'strata://project/overview') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: await buildProjectOverviewJson(workspaceRoot),
        },
      ],
    };
  }

  if (uri === 'strata://components/index') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: await buildComponentsIndexJson(workspaceRoot),
        },
      ],
    };
  }

  const componentMatch = uri.match(/^strata:\/\/component\/([^/?#]+)$/);
  if (componentMatch) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: await buildComponentDetailJson(workspaceRoot, componentMatch[1]),
        },
      ],
    };
  }

  throw new Error(`Unknown resource URI: '${uri}'`);
}

export async function getStrataPrompt(
  name: string,
  args: Record<string, string | undefined> = {},
  explicitRoot?: string
) {
  const workspaceRoot = resolveWorkspaceRoot(explicitRoot);
  const overviewText = await buildProjectOverviewJson(workspaceRoot);
  const embeddedOverview = {
    role: 'user' as const,
    content: {
      type: 'resource' as const,
      resource: {
        uri: 'strata://project/overview',
        mimeType: 'application/json',
        text: overviewText,
      },
    },
  };

  const playbook = findWorkflowPlaybook(name);
  if (!playbook) {
    throw new Error(`Unknown prompt: '${name}'`);
  }

  const targetArg =
    playbook.name === 'trace-state-bug'
      ? (args.target ?? '').trim() || '<target>'
      : playbook.name === 'safe-component-patch'
        ? (args.component ?? '').trim() || '<component>'
        : (args.entry ?? '').trim() || '<entry>';

  const ctx = {
    target: targetArg,
    workspaceRoot,
    refactorType: args.refactor_type,
  };

  return {
    description: playbook.promptDescription,
    messages: [
      embeddedOverview,
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [playbook.intro(ctx), ...playbook.steps(ctx)].join('\n'),
        },
      },
    ],
  };
}
