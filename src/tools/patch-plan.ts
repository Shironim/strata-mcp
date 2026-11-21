import { toolMetadata } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { generatePatchPlan, normalizePatchOperations } from '../engine/patch-plan';
import { checkPatchPreconditions } from '../engine/patch-preconditions';
import { indexedRetrievalEvidence } from '../engine/index-retrieval-evidence';
import { prepareIndexedAnalysis } from '../engine/prepare-index';
import { formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { relative, resolve } from 'node:path';
import { resolveWorkspacePath, findProjectRoot } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';
import type { PatchRefactorType, PatchOperation, PatchPlanResult, RetrievalEvidence } from '../types';

const patchPlanToolDefinition: McpToolDefinition = {
  ...toolMetadata('generate_patch_plan'),
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
        structuredContent: { error: { code: 'INVALID_ARGUMENT' } },
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

    const rawOps = args.operations ?? args.batch_operations;
    let operations: PatchOperation[] | undefined = undefined;
    if (Array.isArray(rawOps) && rawOps.length > 0) {
      operations = rawOps.map((op: any) => ({
        refactorType: (op.refactor_type || op.refactorType || op.refactor) as PatchRefactorType,
        oldName: String(op.old_name ?? op.oldName ?? op.old ?? ''),
        newName: (op.new_name ?? op.newName ?? op.new) ? String(op.new_name ?? op.newName ?? op.new) : undefined,
      }));
    }

    const refactorType = (args.refactor_type || args.refactorType || args.refactor) as PatchRefactorType;
    const oldName = String(args.old_name ?? args.oldName ?? args.old ?? '');
    const rawNewName = args.new_name ?? args.newName ?? args.new;
    const newName = rawNewName ? String(rawNewName) : undefined;

    try {
      normalizePatchOperations({ componentPath, refactorType, oldName, newName, operations });
      const workspace = targetPath ?? findProjectRoot(componentPath);
      const before = await prepareIndexedAnalysis(workspace, true);
      const plan = await generatePatchPlan({
        componentPath,
        refactorType: refactorType || operations?.[0]?.refactorType,
        oldName: oldName || operations?.[0]?.oldName,
        newName: newName ?? operations?.[0]?.newName,
        targetPath,
        operations,
        skipSync: true,
      });

      const preconditionCheck = await checkPatchPreconditions(plan.patches);
      plan.preconditionsValidated = preconditionCheck.valid;
      plan.patchValidation = preconditionCheck;
      if (!preconditionCheck.valid) {
        for (const err of preconditionCheck.errors) {
          plan.coverage.diagnostics.push({ file: componentPath, code: 'PRECONDITION_FAILED', message: err });
        }
      }

      const retrieval = indexedRetrievalEvidence({ workspace, scope: workspace, policy: 'consumer-patch-plan-v1', before,
        query: { componentPath, refactorType: plan.refactorType, oldName: plan.oldName, newName: plan.newName ?? null, operations: plan.operations ?? null },
        selectionReason: 'Upward consumer candidates and supported static usages for the requested component refactor.' });
      retrieval.omissions.push(...plan.coverage.diagnostics.map(d => ({ code: d.code, reason: `${d.file}: ${d.message}` })), ...plan.coverage.omissions.map(d => ({ code: d.code, reason: `${d.file}: ${d.message}` })));

      const isJson = args.output_format === 'json' || args.format === 'json';

      if (isJson) {
        return {
          structuredContent: { ...plan, retrieval },
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...plan, retrieval }, null, 2),
            },
          ],
        };
      }

      return {
        structuredContent: { ...plan, retrieval },
        content: [
          {
            type: 'text',
            text: formatPatchPlanAsText(plan, retrieval),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        structuredContent: { error: { code: err instanceof Error && 'code' in err && err.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'HANDLER_ERROR' } },
        content: [{ type: 'text', text: `Failed to generate patch plan: ${msg}` }],
      };
    }
  },
};

export function formatPatchPlanAsText(plan: PatchPlanResult, retrieval?: RetrievalEvidence): string {
  const isBatch = Boolean(plan.operations && plan.operations.length > 1);
  const title = isBatch && plan.operations ? `BATCH (${plan.operations.length} operations)` : plan.refactorType.toUpperCase();
  const displayRoot = findProjectRoot(plan.component);
  const shortFile = (filePath: string) => {
    const rel = relative(displayRoot, filePath);
    return rel && !rel.startsWith('..') ? rel : filePath;
  };
  const maxDepthItems = plan.coverage.diagnostics.filter((d) => d.code === 'MAX_DEPTH_REACHED');
  const otherDiagnostics = plan.coverage.diagnostics.filter((d) => d.code !== 'MAX_DEPTH_REACHED');
  const maxDepthLines = maxDepthItems.length > 0
    ? (() => {
        const shown = maxDepthItems.slice(0, 5).map((d) => shortFile(d.file)).join(', ');
        const extra = maxDepthItems.length > 5 ? `, and ${maxDepthItems.length - 5} more` : '';
        return [`- **MAX_DEPTH_REACHED:** ${maxDepthItems.length} node(s) not expanded (${shown}${extra})`];
      })()
    : [];
  const lines: string[] = [
    `# Prescriptive Patch Plan: ${title}`,
    `- **Target Component:** \`${plan.component}\``,
    ...(isBatch && plan.operations
      ? plan.operations.map((op) => `  - ${op.refactorType}: \`${op.oldName}\`${op.newName ? ` -> \`${op.newName}\`` : ''}`)
      : [
          `- **Old Symbol:** \`${plan.oldName}\``,
          ...(plan.newName ? [`- **New Symbol:** \`${plan.newName}\``] : []),
        ]),
    `- **Consumers Audited:** ${plan.totalConsumersAudited}`,
    `- **Candidate Consumers:** ${plan.coverage.candidateCount}`,
    `- **Failed / Unsupported:** ${plan.coverage.failedCount} / ${plan.coverage.unsupportedCount}`,
    `- **Patches Found:** ${plan.totalPatches}`,
    `- **Patch Preconditions:** ${plan.preconditionsValidated ? 'valid for the proposed patches' : 'invalid'}; consumer discovery coverage is evaluated separately.`,
    '- **Coverage:** bounded by graph discovery and supported static usages; forwarding and dynamic usages may be omitted.',
    ...maxDepthLines,
    ...otherDiagnostics.map(d => `- **${d.code}:** ${shortFile(d.file)}: ${d.message}`),
    '- **Operation scope:** supported static consumer usages; target declarations, forwarding, and dynamic components are not rewritten.',
    ...plan.coverage.omissions.map(d => `- **Omission ${d.code} (${d.resolution}):** ${shortFile(d.file)}: ${d.message}${d.sourceRef ? ` [SHA-256 ${d.sourceRef.sha256.slice(0, 12)}, UTF-16 ${d.sourceRef.startOffset}:${d.sourceRef.endOffset}]` : ''}`),
    '',
  ];

  const declLines: string[] = [];
  if (plan.targetDeclarations && plan.targetDeclarations.length > 0) {
    declLines.push('### Target Component Declarations:');
    for (const decl of plan.targetDeclarations) {
      if (decl.found && decl.line !== undefined) {
        declLines.push(
          `- **[\`${shortFile(decl.file)}#L${decl.line}\`](file://${decl.file}#L${decl.line})** (${decl.kind} \`${decl.symbol}\`): \`${decl.snippet ?? ''}\``
        );
      } else if (decl.found) {
        declLines.push(`- **${decl.kind} \`${decl.symbol}\`:** declared in target contract (line not pinpointed)`);
      } else {
        declLines.push(`- **${decl.kind} \`${decl.symbol}\`:** not found in extracted target contract`);
      }
    }
    declLines.push('');
  }

  if (plan.patches.length === 0) {
    lines.push(...declLines);
    lines.push('No patches found within the analyzed static usages. This does not establish that all affected usages were discovered or supported.');
  } else {
    lines.push(...declLines);
    lines.push('### Proposed Code Replacements:');
    for (const patch of plan.patches) {
      lines.push(
        `- **[\`${shortFile(patch.file)}#L${patch.line}:${patch.column}\`](file://${patch.file}#L${patch.line})**`
      );
      lines.push(`  - *Context:* Tag \`<${patch.targetTag}>\``);
      lines.push(`  - *Action:* ${patch.description}`);
      lines.push(`  - *Current:* \`${patch.oldSnippet}\``);
      lines.push(`  - *Replace with:* \`${patch.newSnippet || '(remove)'}\``);
      lines.push('');
    }
  }

  if (retrieval) lines.push(formatRetrievalEvidence(retrieval));
  return lines.join('\n');
}

export const patchPlanTool: McpToolDefinition = withRetrievalEvidence(patchPlanToolDefinition, {
  formatText: (data, page) => {
    if (page.path === 'patches' && Array.isArray(data.patches)) {
      return formatPatchPlanAsText(data as PatchPlanResult);
    }
    return undefined;
  },
});
