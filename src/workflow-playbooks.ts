export interface WorkflowPlaybookArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface WorkflowPlaybookContext {
  target: string;
  workspaceRoot: string;
  refactorType?: string;
}

export interface WorkflowPlaybook {
  name: 'open-apps' | 'onboard-workspace' | 'trace-bug' | 'safe-refactor';
  title: string;
  description: string;
  arguments: readonly WorkflowPlaybookArgument[];
  promptDescription: string;
  intro: (ctx: WorkflowPlaybookContext) => string;
  steps: (ctx: WorkflowPlaybookContext) => string[];
}

export const WORKFLOW_PLAYBOOKS: readonly WorkflowPlaybook[] = [
  {
    name: 'open-apps',
    title: 'Open Apps',
    description:
      'Launch the interactive Strata Explorer UI and summarize workspace overview, routes, and health.',
    arguments: [
      {
        name: 'workspace_path',
        description: 'Optional workspace root path (defaults to the active project root).',
        required: false,
      },
    ],
    promptDescription: 'Open Strata Explorer and present next steps for overview, routes, and component impact.',
    intro: ({ workspaceRoot }) =>
      `Open the Strata Explorer MCP App for \`${workspaceRoot}\` and summarize the workspace:`,
    steps: ({ workspaceRoot }) => [
      `1. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "overview" }\` to open **Strata Explorer** (\`ui://strata/explorer.html\`) and load package topology, frameworks, and totals.`,
      `2. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "health" }\` (or read \`strata://apps\`) to check the verification tier, unused component candidates, and any diagnostics.`,
      '3. Summarize what you found and list next steps you can take inside **Strata Explorer**:',
      '   - **Overview & Health tab**: Review package totals and any unused component candidates; select candidates and click **Ask AI** / **Attach Context** for cleanup triage, or click **Tree** to check consumers.',
      '   - **Routes tab**: Filter page and API routes by URL or file path, select routes for AI analysis, or click **Open** to jump to source.',
      '   - **Tree & Impact tab**: Search a component to inspect its hierarchy, TypeChecker props/emits/slots contract, outbound HTTP boundaries, impact sites, and `DYNAMIC_SPREAD` omissions.',
    ],
  },
  {
    name: 'onboard-workspace',
    title: 'Onboard Workspace',
    description:
      'Map packages, routes, and key entrypoint files in an unfamiliar frontend repo or monorepo.',
    arguments: [
      {
        name: 'package',
        description: 'Optional monorepo package key (e.g. "apps/web") to focus on.',
        required: false,
      },
    ],
    promptDescription: 'Map packages, routes, and key entrypoint contracts without reading full files.',
    intro: ({ target }) => `Map the architecture of ${target ? `package '${target}'` : 'this workspace'}:`,
    steps: ({ target, workspaceRoot }) => [
      `1. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "overview"${target ? `, package: "${target}"` : ''} }\` to list packages, frameworks, and totals.`,
      `2. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "routes"${target ? `, package: "${target}"` : ''} }\` to locate page, layout, and API entrypoints.`,
      `3. Call \`inspect_file\` on key entrypoints to review symbol outlines, props/slots contracts, and outbound HTTP boundaries without reading file bodies.`,
    ],
  },
  {
    name: 'trace-bug',
    title: 'Trace Bug',
    description:
      'Trace UI, state, or API bugs across symbols, state flow, and call hierarchies.',
    arguments: [
      {
        name: 'target',
        description: 'Store, composable, component, or symbol name to trace.',
        required: true,
      },
    ],
    promptDescription: 'Locate the symbol, map its state flow and callers, then read only the relevant slice.',
    intro: ({ target }) => `Trace the bug involving '${target}' in order:`,
    steps: ({ target, workspaceRoot }) => [
      `1. Call \`search_code\` with \`{ root: "${workspaceRoot}", query: "${target}", kind: "symbol" }\` to get its \`symbol_id\` and \`source_ref\`.`,
      `2. Call \`query_graph\` with \`{ root: "${workspaceRoot}", query: "state_flow", target: { symbol: "${target}" } }\` or \`query: "call_hierarchy"\` to map readers, writers, and callers.`,
      `3. Call \`read_slice\` with the returned \`source_ref\` or \`symbol_id\` to inspect only the relevant implementation lines.`,
    ],
  },
  {
    name: 'safe-refactor',
    title: 'Safe Refactor',
    description:
      'Check component contracts, consumers, and edit impact sites (plus dynamic omissions) before refactoring.',
    arguments: [
      {
        name: 'component',
        description: 'Component or module file path to refactor.',
        required: true,
      },
      {
        name: 'member',
        description: 'Optional prop, event, slot, or symbol name being changed.',
        required: false,
      },
    ],
    promptDescription: 'Verify contracts, upward consumers, and impact sites before editing.',
    intro: ({ target }) => `Verify impact before refactoring '${target}':`,
    steps: ({ target, workspaceRoot, refactorType }) => {
      const memberPart = refactorType?.trim() ? `, member: "${refactorType.trim()}"` : '';
      return [
        `1. Call \`inspect_file\` with \`{ root: "${workspaceRoot}", path: "${target}" }\` to check its TypeChecker-resolved contract and outline.`,
        `2. Call \`query_graph\` with \`{ root: "${workspaceRoot}", query: "component_tree", direction: "up", target: { file: "${target}" } }\` to map upward consumers across packages.`,
        `3. Call \`query_graph\` with \`{ root: "${workspaceRoot}", query: "impact", target: { file: "${target}"${memberPart} } }\` to list verified edit sites and any dynamic spread omissions.`,
      ];
    },
  },
] as const;

export function findWorkflowPlaybook(name: string): WorkflowPlaybook | undefined {
  return WORKFLOW_PLAYBOOKS.find((p) => p.name === name);
}

export function renderWorkflowPlaybookText(
  playbook: WorkflowPlaybook,
  ctx: WorkflowPlaybookContext
): string {
  return [playbook.intro(ctx), ...playbook.steps(ctx)].join('\n');
}

export function renderPlaybooksForSkill(): string {
  return WORKFLOW_PLAYBOOKS.map((playbook) => {
    const ctx: WorkflowPlaybookContext = {
      target: playbook.name === 'open-apps' || playbook.name === 'onboard-workspace' ? '' : '<target>',
      workspaceRoot: '<workspace-root>',
    };
    return `### ${playbook.title} (\`${playbook.name}\`)\n${playbook.steps(ctx).join('\n')}`;
  }).join('\n\n');
}
