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
      path: {
        type: 'string',
        description: 'Path to the component file being refactored (e.g. "src/components/Button.vue", alias: component_path, file_path)',
      },
      refactor_type: {
        type: 'string',
        enum: [
          'rename_prop',
          'remove_prop',
          'rename_event',
          'remove_event',
          'rename_model',
          'remove_model',
          'rename_slot',
          'remove_slot',
        ],
        description: 'The type of refactoring operation being performed (prop, event, model, or slot)',
      },
      old_name: {
        type: 'string',
        description: 'Current prop, model, slot, or event name (e.g. "is-active", "title", "header", "on-click")',
      },
      new_name: {
        type: 'string',
        description: 'New prop or event name (required when renaming, e.g. "variant", "active")',
      },
      target_path: {
        type: 'string',
        description: 'Workspace or project root directory (default: ".")',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
    },
    required: ['path', 'refactor_type', 'old_name'],
  },
  handler: async (args: Record<string, any>) => {
    const rawPath =
      args.component_path ??
      args.path ??
      args.file_path ??
      args.filePath ??
      args.component;
    if (!rawPath) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: Either "component_path" or "path" (or "file_path") argument must be specified.',
          },
        ],
      };
    }

    const componentPath = resolveWorkspacePath(String(rawPath));
    const targetPath = resolveProjectRoot(args.target_path ? String(args.target_path) : undefined);

    const refactorType = (args.refactor_type || args.refactorType || args.refactor) as PatchRefactorType;
    const oldName = String(args.old_name ?? args.oldName ?? args.old ?? '');
    const rawNewName = args.new_name ?? args.newName ?? args.new;
    const newName = rawNewName ? String(rawNewName) : undefined;

    if (refactorType && refactorType.startsWith('rename_') && !newName) {
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

    try {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to generate patch plan: ${msg}` }],
      };
    }
  },
};
