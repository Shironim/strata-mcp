import { TOOL_CATALOG } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { generatePatchPlan } from '../engine/patch-plan';
import { observeRetrievalIndex, indexedRetrievalEvidence } from '../engine/index-retrieval-evidence';
import { formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { resolve } from 'node:path';
import { resolveWorkspacePath, findProjectRoot } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import type { PatchRefactorType } from '../types';

const patchPlanToolDefinition: McpToolDefinition = {
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
      const workspace = targetPath ?? findProjectRoot(componentPath);
      const before = observeRetrievalIndex(workspace);
      const plan = await generatePatchPlan({
        componentPath,
        refactorType,
        oldName,
        newName,
        targetPath,
      });

      const retrieval = indexedRetrievalEvidence({ workspace, scope: workspace, policy: 'consumer-patch-plan-v1', before,
        query: { componentPath, refactorType, oldName, newName: newName ?? null },
        selectionReason: 'Upward consumer candidates and supported static usages for the requested component refactor.' });
      retrieval.omissions.push(...plan.coverage.diagnostics.map(d => ({ code: d.code, reason: `${d.file}: ${d.message}` })), ...plan.coverage.omissions.map(d => ({ code: d.code, reason: `${d.file}: ${d.message}` })));

      const isJson = args.output_format === 'json' || args.format === 'json';

      if (isJson) {
        return {
          structuredContent: { retrieval },
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...plan, retrieval }, null, 2),
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
        `- **Candidate Consumers:** ${plan.coverage.candidateCount}`,
        `- **Failed / Unsupported:** ${plan.coverage.failedCount} / ${plan.coverage.unsupportedCount}`,
        `- **Patches Found:** ${plan.totalPatches}`,
        '- **Coverage:** bounded by graph discovery and supported static usages; forwarding and dynamic usages may be omitted.',
        ...plan.coverage.diagnostics.map(d => `- **${d.code}:** ${d.file}: ${d.message}`),
        '- **Operation scope:** supported static consumer usages; target declarations, forwarding, and dynamic components are not rewritten.',
        ...plan.coverage.omissions.map(d => `- **Omission ${d.code} (${d.resolution}):** ${d.file}: ${d.message}${d.sourceRef ? ` [SHA-256 ${d.sourceRef.sha256}, UTF-16 ${d.sourceRef.startOffset}:${d.sourceRef.endOffset}]` : ''}`),
        '',
      ];

      if (plan.patches.length === 0) {
        lines.push('No patches found within the analyzed static usages. This does not establish that all affected usages were discovered or supported.');
      } else {
        lines.push('### Proposed Code Replacements:');
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

      lines.push(formatRetrievalEvidence(retrieval));
      return {
        structuredContent: { retrieval },
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

export const patchPlanTool: McpToolDefinition = withRetrievalEvidence(patchPlanToolDefinition);
