import { TOOL_CATALOG } from './catalog';
import { generatePatchPlan } from '../engine/patch-plan';
import { resolve } from 'node:path';
import { resolveWorkspacePath } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import type { PatchRefactorType } from '../types';

export const patchPlanTool: McpToolDefinition = {
  ...TOOL_CATALOG[5],
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
    const rawTargetPath = args.target_path ?? args.targetPath;
    const targetPath = rawTargetPath ? resolve(String(rawTargetPath)) : undefined;

    const refactorType = (args.refactor_type || args.refactorType || args.refactor) as PatchRefactorType;
    const oldName = String(args.old_name ?? args.oldName ?? args.old ?? '');
    const rawNewName = args.new_name ?? args.newName ?? args.new;
    const newName = rawNewName ? String(rawNewName) : undefined;

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
