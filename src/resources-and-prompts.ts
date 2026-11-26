import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLastKnownProjectRoot, isBroadOrHomeDirectory } from './engine/path-resolver';
import {
  inspectFile,
  mapWorkspace,
  searchCode,
} from './engine/v2';
import { STRATA_EXPLORER_UI_URI } from './tools/v2/catalog';
import { findWorkflowPlaybook, WORKFLOW_PLAYBOOKS } from './workflow-playbooks';

declare const STRATA_EMBEDDED_EXPLORER_HTML: string | undefined;

function loadExplorerHtml(): string {
  const envPath = process.env.STRATA_APP_HTML?.trim();
  if (envPath && existsSync(envPath)) return readFileSync(envPath, 'utf8');
  if (typeof STRATA_EMBEDDED_EXPLORER_HTML === 'string') return STRATA_EMBEDDED_EXPLORER_HTML;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'ui', 'explorer.html'),
    resolve(here, '../ui/explorer.html'),
    resolve(here, '../../dist/ui/explorer.html'),
    resolve(process.cwd(), 'dist', 'ui', 'explorer.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8');
    }
  }
  throw new Error('Strata Explorer UI bundle not found. Run "bun run build" first or set STRATA_APP_HTML.');
}

export const STRATA_RESOURCES = [
  {
    uri: STRATA_EXPLORER_UI_URI,
    name: 'Strata Explorer UI',
    description:
      'Interactive Strata Explorer MCP App for workspace overview, routes, component trees, impact sites, and unused component triage.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  {
    uri: 'strata://project/overview',
    name: 'Strata Project Overview',
    description:
      'Detected monorepo packages, frameworks, routers, and file/symbol/route totals for the active workspace.',
    mimeType: 'application/json',
  },
  {
    uri: 'strata://components/index',
    name: 'Strata Components Index',
    description:
      'Bounded list of discovered frontend components and their package-relative paths without source bodies.',
    mimeType: 'application/json',
  },
  {
    uri: 'strata://apps',
    name: 'Strata MCP Apps & Diagnostics Guide',
    description:
      'Interactive Strata Explorer MCP App entrypoints, workspace verification/health summary, and actionable next steps.',
    mimeType: 'application/json',
  },
] as const;

export const STRATA_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'strata://component/{name}',
    name: 'Strata Component Contract',
    description:
      'Read-only component outline, TypeChecker-resolved props/slots contract, and outbound HTTP boundaries.',
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

interface ResolvedWorkspaceRoot {
  workspaceRoot: string;
  isUnsafeFallback: boolean;
}

function resolveWorkspaceRoot(explicitRoot?: string): ResolvedWorkspaceRoot {
  const explicit = explicitRoot?.trim();
  if (explicit) {
    return { workspaceRoot: resolve(explicit), isUnsafeFallback: false };
  }
  const known = getLastKnownProjectRoot();
  if (known) {
    return { workspaceRoot: resolve(known), isUnsafeFallback: false };
  }
  const cwd = resolve(process.cwd());
  return {
    workspaceRoot: cwd,
    isUnsafeFallback: isBroadOrHomeDirectory(cwd),
  };
}

function parseResourceUri(uri: string): { baseUri: string; workspaceParam?: string } {
  const qIdx = uri.indexOf('?');
  if (qIdx === -1) return { baseUri: uri };
  const baseUri = uri.slice(0, qIdx);
  const params = new URLSearchParams(uri.slice(qIdx + 1));
  const ws = params.get('workspace')?.trim();
  return { baseUri, workspaceParam: ws || undefined };
}

async function buildAppsGuide(workspaceRoot: string) {
  const [overview, health] = await Promise.all([
    mapWorkspace({ workspaceRoot, view: 'overview' }),
    mapWorkspace({ workspaceRoot, view: 'health', limit: 50 }),
  ]);

  const totals = overview.data.totals ?? { packages: 0, files: 0, symbols: 0, routes: 0 };
  const packages = overview.data.packages ?? [];
  const unusedCount = health.data.health?.unusedComponents?.length ?? 0;
  const diagnostics = [...overview.diagnostics, ...health.diagnostics];
  const actionableActions: Array<{ action: string; reason: string; tool?: string }> = [];

  if (totals.files === 0) {
    actionableActions.push({
      action: 'Verify workspace root or supported frameworks',
      reason: 'No supported frontend files (.vue, .tsx, .jsx, .svelte, .astro, .ts, .js) were indexed.',
      tool: `map_workspace({ root: "${workspaceRoot}", view: "packages" })`,
    });
  } else {
    if (unusedCount > 0) {
      actionableActions.push({
        action: 'Triage unused component candidates',
        reason: `${unusedCount} unused component candidate(s) found; verify dynamic/global usages before removing.`,
        tool: `map_workspace({ root: "${workspaceRoot}", view: "health" })`,
      });
    }
    if (totals.routes > 0) {
      actionableActions.push({
        action: 'Explore route entrypoints in Strata Explorer',
        reason: `${totals.routes} route(s) mapped across ${totals.packages} package(s).`,
        tool: `map_workspace({ root: "${workspaceRoot}", view: "routes" })`,
      });
    }
    if (overview.verification !== 'semantic' && overview.verification !== 'graph') {
      actionableActions.push({
        action: 'Check TypeScript/tsconfig setup',
        reason: `Verification tier is "${overview.verification}" rather than full semantic/graph resolution.`,
      });
    }
  }

  return {
    workspace_root: workspaceRoot,
    ui_resource: STRATA_EXPLORER_UI_URI,
    open_via_tools: ['map_workspace'],
    interactive_tools: ['map_workspace', 'inspect_file', 'query_graph', 'search_code'],
    antigravity_entrypoints: [
      { type: 'aux_pane', title: 'Strata Explorer' },
      { type: 'global', title: 'Strata' },
    ],
    verification: overview.verification,
    totals,
    packages: packages.map((p) => ({
      packageKey: p.packageKey,
      framework: p.framework,
      fileCount: p.fileCount,
      symbolCount: p.symbolCount,
      routeCount: p.routeCount,
    })),
    unused_components_count: unusedCount,
    diagnostics,
    actionable_actions: actionableActions,
  };
}

export async function readStrataResource(uri: string, explicitRoot?: string) {
  const { baseUri, workspaceParam } = parseResourceUri(uri);

  if (baseUri === STRATA_EXPLORER_UI_URI) {
    return {
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: loadExplorerHtml(),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  }

  const { workspaceRoot, isUnsafeFallback } = resolveWorkspaceRoot(workspaceParam ?? explicitRoot);

  if (isUnsafeFallback) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              workspace_root: null,
              diagnostics: [
                {
                  code: 'WORKSPACE_ROOT_REQUIRED',
                  message: `Refused to auto-scan broad directory "${workspaceRoot}" because no explicit workspace root or MCP client root was provided. Pass "?workspace=<absolute-path>" or call map_workspace({ root: "<active-workspace-root>" }).`,
                },
              ],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (baseUri === 'strata://apps') {
    const guide = await buildAppsGuide(workspaceRoot);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(guide, null, 2),
        },
      ],
    };
  }

  if (baseUri === 'strata://project/overview') {
    const overview = await mapWorkspace({ workspaceRoot, view: 'overview' });
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(overview, null, 2),
        },
      ],
    };
  }

  if (baseUri === 'strata://components/index') {
    const files = await mapWorkspace({ workspaceRoot, view: 'files', limit: 150 });
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(files, null, 2),
        },
      ],
    };
  }

  const compMatch = /^strata:\/\/component\/(.+)$/.exec(baseUri);
  if (compMatch) {
    const compName = decodeURIComponent(compMatch[1]);
    const hits = await searchCode({
      workspaceRoot,
      query: compName,
      kind: 'symbol',
      symbolKinds: ['component'],
      limit: 5,
    });
    const inspections = [];
    for (const hit of hits.data.matches) {
      try {
        inspections.push(
          await inspectFile({ workspaceRoot, path: hit.filePath, skipSync: true })
        );
      } catch {
        // skip unreadable candidate
      }
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ component: compName, matches: inspections }, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown Strata resource URI: "${uri}"`);
}

export async function getStrataPrompt(
  name: string,
  rawArgs?: Record<string, string>,
  explicitRoot?: string
) {
  const args = rawArgs ?? {};
  const explicitArg = args.workspace_path?.trim() || args.root?.trim();
  const { workspaceRoot, isUnsafeFallback } = resolveWorkspaceRoot(explicitArg || explicitRoot);
  const playbook = findWorkflowPlaybook(name);
  if (!playbook) {
    throw new Error(`Unknown prompt: '${name}'`);
  }

  const targetArg =
    playbook.name === 'trace-bug'
      ? (args.target ?? '').trim() || '<target>'
      : playbook.name === 'safe-refactor'
        ? (args.component ?? '').trim() || '<component>'
        : (args.package ?? '').trim();

  if (isUnsafeFallback) {
    const ctx = {
      target: targetArg,
      workspaceRoot: '<active-workspace-root>',
      refactorType: args.member ?? args.refactor_type,
    };
    const guardrailNote = `Note: No workspace root was provided by the MCP client and the server's default cwd (\`${workspaceRoot}\`) is a home/root directory, so automatic scanning was skipped. Replace \`<active-workspace-root>\` below with the absolute path of the user's currently open workspace.`;
    return {
      description: playbook.promptDescription,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [guardrailNote, '', playbook.intro(ctx), ...playbook.steps(ctx)].join('\n'),
          },
        },
      ],
    };
  }

  const overview = await mapWorkspace({ workspaceRoot, view: 'overview' });

  const ctx = {
    target: targetArg,
    workspaceRoot,
    refactorType: args.member ?? args.refactor_type,
  };

  return {
    description: playbook.promptDescription,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'resource' as const,
          resource: {
            uri: 'strata://project/overview',
            mimeType: 'application/json',
            text: JSON.stringify(overview, null, 2),
          },
        },
      },
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
