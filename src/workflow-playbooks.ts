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
  name: 'trace-state-bug' | 'safe-component-patch' | 'audit-component-tree';
  title: string;
  description: string;
  arguments: readonly WorkflowPlaybookArgument[];
  promptDescription: string;
  intro: (ctx: WorkflowPlaybookContext) => string;
  steps: (ctx: WorkflowPlaybookContext) => string[];
}

export const WORKFLOW_PLAYBOOKS: readonly WorkflowPlaybook[] = [
  {
    name: 'trace-state-bug',
    title: 'Trace State Bug',
    description:
      'Investigate reactive state, store, or composable bugs using find_code, inspect_component, and trace_state.',
    arguments: [
      {
        name: 'target',
        description: 'Store, composable, context, or component name/path to investigate.',
        required: true,
      },
    ],
    promptDescription: 'Trace reactive state, store, or composable bugs across consumers and mutators.',
    intro: ({ target }) => `Investigate state or reactivity bug involving '${target}' in order:`,
    steps: ({ target, workspaceRoot }) => [
      `1. Call \`find_code\` with \`{ pattern: "${target}", path: "${workspaceRoot}" }\` (or \`action: "map"\` if the location is unknown) to locate the store, composable, or component.`,
      `2. Call \`inspect_component\` with \`{ path: "<resolved-file>", symbol: "<symbol-or-omit>" }\` to inspect its contract and state dependencies without reading the whole file.`,
      `3. Call \`trace_state\` with \`{ path: "${workspaceRoot}", identifier: "${target}", direction: "both", role: "all", depth: 2 }\` to trace readers, mutators, and multi-hop ancestors.`,
    ],
  },
  {
    name: 'safe-component-patch',
    title: 'Safe Component Patch',
    description:
      'Inspect component contract, upward consumer blast radius, and generate a deterministic patch plan before refactoring.',
    arguments: [
      {
        name: 'component',
        description: 'Component file path or name to refactor.',
        required: true,
      },
      {
        name: 'refactor_type',
        description:
          'Optional refactor type (rename_prop, remove_prop, rename_event, remove_event, rename_model, remove_model, rename_slot, remove_slot).',
        required: false,
      },
    ],
    promptDescription: 'Inspect contract, evaluate upward blast radius, and build a patch plan before editing.',
    intro: ({ target }) => `Prepare a safe refactor for '${target}' before editing source files:`,
    steps: ({ target, workspaceRoot, refactorType }) => {
      const type = refactorType?.trim() || 'rename_prop';
      return [
        `1. Call \`inspect_component\` with \`{ path: "${target}", impact: "summary" }\` to inspect props, emits, slots, models, and per-prop usage/omission risk.`,
        `2. Call \`get_component_tree\` with \`{ path: "${target}", direction: "upward", target_path: "${workspaceRoot}" }\` to map all parent consumers and page entrypoints.`,
        `3. Call \`generate_patch_plan\` with \`{ path: "${target}", refactor_type: "${type}", old_name: "<old_name>", new_name: "<new_name>", target_path: "${workspaceRoot}" }\` to get a deterministic, reviewable patch plan before applying edits.`,
      ];
    },
  },
  {
    name: 'audit-component-tree',
    title: 'Audit Component Tree',
    description:
      'Analyze downward component hierarchy for props drilling, dangling context, and render boundaries.',
    arguments: [
      {
        name: 'entry',
        description: 'Entry component file path or URL route (e.g. "/dashboard").',
        required: true,
      },
    ],
    promptDescription:
      'Audit downward component hierarchy for props drilling, dangling context, and render boundaries.',
    intro: ({ target }) => `Audit the component tree starting from '${target}':`,
    steps: ({ target, workspaceRoot }) => {
      const isRoute = target.startsWith('/') && !/\.(vue|tsx|jsx|svelte|astro|ts|js|mjs|cjs)$/i.test(target);
      const entryParam = isRoute ? `route: "${target}"` : `path: "${target}"`;
      return [
        `1. Call \`get_component_tree\` with \`{ ${entryParam}, direction: "downward", target_path: "${workspaceRoot}" }\` to inspect rendered descendants, props drilling (>2 levels), dangling context, and render boundaries.`,
        `2. For any flagged component, call \`inspect_component\` with \`{ path: "<component-file>" }\` to verify its exact props, emits, and state dependencies.`,
        `3. If broader topology or unused-component context is needed, call \`audit_frontend\` with \`{ target: "routes", path: "${workspaceRoot}" }\` or \`{ target: "dead-components", path: "${workspaceRoot}" }\`.`,
      ];
    },
  },
] as const;

export function findWorkflowPlaybook(name: string): WorkflowPlaybook | undefined {
  return WORKFLOW_PLAYBOOKS.find((p) => p.name === name);
}

/**
 * Renders the canonical workflow playbooks for SKILL.md / CLI init templates
 * so skill guidance stays synchronized with MCP Prompts.
 */
export function renderPlaybooksForSkill(): string {
  return WORKFLOW_PLAYBOOKS.map((playbook) => {
    const sampleTarget =
      playbook.name === 'trace-state-bug'
        ? '<storeOrComposable>'
        : playbook.name === 'safe-component-patch'
          ? '<componentFile>'
          : '<entryComponentOrRoute>';
    const steps = playbook.steps({
      target: sampleTarget,
      workspaceRoot: '<workspaceRoot>',
      refactorType: 'rename_prop',
    });
    return `### ${playbook.title} (\`${playbook.name}\`)\n${playbook.description}\n${steps.join('\n')}`;
  }).join('\n\n');
}
