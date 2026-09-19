import { generatePatchPlan } from '../engine/patch-plan';
import { resolveWorkspacePath, resolveProjectRoot } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import type { PatchRefactorType } from '../types';

export const patchPlanTool: McpToolDefinition = {
  name: 'generate_patch_plan',
  description:
    'Prescriptive Refactoring: Generates precise AST-level patch recommendations (file, line, column, oldSnippet, newSnippet) across all upward consumer components when refactoring, renaming, or removing props and events.',
  inputSchema: {
    type: 'object',
    properties: {
      component_path: {
        type: 'string',
        description: 'Path to the component file being refactored (e.g. "src/components/Button.vue")',
      },
      path: {
        type: 'string',
        description: 'Alias for component_path',
      },
      refactor_type: {
        type: 'string',
        enum: ['rename_prop', 'remove_prop', 'rename_event', 'remove_event'],
        description: 'The type of refactoring operation being performed',
      },
      old_name: {
        type: 'string',
        description: 'Current prop or event name (e.g. "is-active", "type", "on-click")',
      },
      new_name: {
        type: 'string',
        description: 'New prop or event name (required when renaming, e.g. "variant", "active")',
      },
      target_path: {
        type: 'string',
        description: 'Workspace or project root directory (default: ".")',
      },
    },
    required: ['refactor_type', 'old_name'],
  },
  handler: async (args: Record<string, any>) => {
    const rawPath = args.component_path ?? args.path;
    if (!rawPath) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: Either "component_path" or "path" argument must be specified.',
          },
        ],
      };
    }

    const componentPath = resolveWorkspacePath(String(rawPath));
    const targetPath = resolveProjectRoot(args.target_path ? String(args.target_path) : undefined);

    const refactorType = args.refactor_type as PatchRefactorType;
    const oldName = String(args.old_name);
    const newName = args.new_name ? String(args.new_name) : undefined;

    if ((refactorType === 'rename_prop' || refactorType === 'rename_event') && !newName) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: "new_name" is required when refactor_type is "${refactorType}".`,
          },
        ],
      };
    }

    const plan = await generatePatchPlan({
      componentPath,
      refactorType,
      oldName,
      newName,
      targetPath,
    });

    const isJson = args.output_format === 'json' || args.format === 'json';

    if (isJson) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    }

    // Human-readable / Agent-ready markdown representation
    const lines: string[] = [
      `# Prescriptive Patch Plan: ${refactorType.toUpperCase()}`,
      `- **Target Component:** \`${plan.component}\``,
      `- **Old Symbol:** \`${plan.oldName}\``,
      ...(plan.newName ? [`- **New Symbol:** \`${plan.newName}\``] : []),
      `- **Consumers Audited:** ${plan.totalConsumersAudited}`,
      `- **Total Patches Required:** ${plan.totalPatches}`,
      '',
    ];

    if (plan.patches.length === 0) {
      lines.push('No affected usages found in upward consumer components.');
    } else {
      lines.push('### Required Code Replacements:');
      for (const patch of plan.patches) {
        lines.push(
          `- **[\`${patch.file}#L${patch.line}:${patch.column}\`](file://${patch.file}#L${patch.line})**`
        );
        lines.push(`  - *Context:* Tag \`<${patch.targetTag}>\``);
        lines.push(`  - *Action:* ${patch.description}`);
        lines.push(`  - *Current:* \`${patch.oldSnippet}\``);
        lines.push(`  - *Replace with:* \`${patch.newSnippet || '(remove)'}\``);
        lines.push('');
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
    };
  },
};
