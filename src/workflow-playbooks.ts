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
  name: 'onboard-workspace' | 'trace-bug' | 'safe-refactor';
  title: string;
  description: string;
  arguments: readonly WorkflowPlaybookArgument[];
  promptDescription: string;
  intro: (ctx: WorkflowPlaybookContext) => string;
  steps: (ctx: WorkflowPlaybookContext) => string[];
}

export const WORKFLOW_PLAYBOOKS: readonly WorkflowPlaybook[] = [
  {
    name: 'onboard-workspace',
    title: 'Onboard Workspace',
    description:
      'Build a mental model of an unfamiliar frontend repository or monorepo using map_workspace and inspect_file.',
    arguments: [
      {
        name: 'package',
        description: 'Optional monorepo package key (e.g. "apps/web") to focus on.',
        required: false,
      },
    ],
    promptDescription: 'Map packages, routes, and key entrypoint contracts without reading full source files.',
    intro: ({ target }) => `Build an architectural mental model for ${target ? `package '${target}'` : 'this workspace'}:`,
    steps: ({ target, workspaceRoot }) => [
      `1. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "overview"${target ? `, package: "${target}"` : ''} }\` to see packages, frameworks, and totals.`,
      `2. Call \`map_workspace\` with \`{ root: "${workspaceRoot}", view: "routes"${target ? `, package: "${target}"` : ''} }\` to locate page and layout entrypoints.`,
      `3. Call \`inspect_file\` on key entrypoint files to inspect their symbol outline, props contract, and outbound HTTP boundaries without loading bodies.`,
    ],
  },
  {
    name: 'trace-bug',
    title: 'Trace Bug',
    description:
      'Investigate UI, state, or API flow bugs using search_code, query_graph, and read_slice.',
    arguments: [
      {
        name: 'target',
        description: 'Store, composable, component, or symbol name to investigate.',
        required: true,
      },
    ],
    promptDescription: 'Trace state flow, call hierarchy, and component consumers before reading targeted slices.',
    intro: ({ target }) => `Investigate bug involving '${target}' in order:`,
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
      'Inspect contracts and compute semantic impact sites (plus dynamic omissions) before modifying shared components or symbols.',
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
    promptDescription: 'Verify contract, upward component tree, and all impact sites + omissions before editing.',
    intro: ({ target }) => `Prepare a safe refactor for '${target}' before editing source files:`,
    steps: ({ target, workspaceRoot, refactorType }) => {
      const memberPart = refactorType?.trim() ? `, member: "${refactorType.trim()}"` : '';
      return [
        `1. Call \`inspect_file\` with \`{ root: "${workspaceRoot}", path: "${target}" }\` to verify its TypeChecker-resolved contract and outline.`,
        `2. Call \`query_graph\` with \`{ root: "${workspaceRoot}", query: "component_tree", direction: "up", target: { file: "${target}" } }\` to map upward consumers across packages.`,
        `3. Call \`query_graph\` with \`{ root: "${workspaceRoot}", query: "impact", target: { file: "${target}"${memberPart} } }\` to list all verified edit sites and any dynamic spread omissions.`,
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
      target: playbook.name === 'onboard-workspace' ? '' : '<target>',
      workspaceRoot: '<workspace-root>',
    };
    return `### ${playbook.title} (\`${playbook.name}\`)\n${playbook.steps(ctx).join('\n')}`;
  }).join('\n\n');
}
