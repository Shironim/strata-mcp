import { selectInspectOperation } from './request';
import { toolMetadata } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { renderBoundaryOmission } from './boundary-evidence';
import { resolveProjectOwnership } from '../engine/project-ownership';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, relative, isAbsolute, resolve } from 'node:path';
import { collectFiles } from '../engine/collector';
import { auditEventHandlers, formatEventHandlerAuditAsText } from '../engine/reactivity';
import { extractComponentContract, formatContractAsText } from '../engine/contract';
import { formatOutlineAsText } from '../engine/outline';
import { resolveWorkspacePath, findProjectRoot, PROJECT_ROOT_MARKERS } from '../engine/path-resolver';
import { readSourceSnapshot, readSourceFile } from '../engine/source-file';
import { derivedRetrievalEvidence, formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { formatSourceMapAsText } from '../engine/source-map';
import { inspectVueTreeInput } from '../engine/graph/vue-tree-input';
import { loadAliasConfigWithDependencies } from '../engine/resolver';
import { analyzePropImpact, formatPropImpactAsText } from '../engine/prop-impact';
import type { ComponentContract, RetrievalEvidence } from '../types';
import type { McpToolDefinition } from './types';
import { inspectSource, formatSfcSectionsAsText } from './inspect-source';
import { inspectSymbols } from './inspect-symbols';

const inspectComponentToolDefinition: McpToolDefinition = {
  ...toolMetadata('inspect_component'),
  handler: async (args: Record<string, any>) => {
    const rawTargetHint = args.root || args.project_root || args.target_path || args.targetPath;
    const targetPathHint = rawTargetHint && !/\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(rawTargetHint))
      ? String(rawTargetHint)
      : undefined;
    const rawPath = (args.path || args.file_path || args.filePath || args.target_path || args.targetPath || args.component || args.component_path)
      ? String(args.path || args.file_path || args.filePath || args.target_path || args.targetPath || args.component || args.component_path)
      : (targetPathHint || '');

    if (!rawPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: "Missing required argument: 'path' (or 'file_path', 'target_path')" }],
      };
    }

    const filePath = resolveWorkspacePath(rawPath, targetPathHint);

    if (!fs.existsSync(filePath)) {
      const root = targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath);
      const rel = relative(root, filePath);
      let suggestions: string[] = [];
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') &&
          (targetPathHint || PROJECT_ROOT_MARKERS.some(marker => fs.existsSync(resolve(root, marker))))) {
        try {
          const stem = basename(filePath, extname(filePath));
          suggestions = (await collectFiles(root))
            .filter(candidate => basename(candidate, extname(candidate)) === stem)
            .sort().slice(0, 5);
        } catch {
          // Suggestions are optional; retain the original not-found diagnostic.
        }
      }
      const error = `Component file not found: ${filePath}`;
      const isJson = args.output_format === 'json' || args.format === 'json';
      return {
        isError: true,
        content: [{ type: 'text', text: isJson
          ? JSON.stringify({ error, requestedPath: filePath, suggestions }, null, 2)
          : error + (suggestions.length ? '\nCandidate paths (retry with the intended path):\n' + suggestions.join('\n') : '') }],
      };
    }

    try {
      if (fs.statSync(filePath).isDirectory()) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Target path '${filePath}' is a directory. 'inspect_component' requires a component file (e.g. .vue, .tsx, .jsx, .astro). Use 'audit_frontend' or 'get_component_tree' to inspect directories.`,
            },
          ],
        };
      }
    } catch {}

    const isJson = args.output_format === 'json' || args.format === 'json';
    let selection: ReturnType<typeof selectInspectOperation>;
    try { selection = selectInspectOperation(args); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
    const { impact } = selection;

    try {
      const selected = selection.operation === 'symbol' || selection.operation === 'outline'
        ? await inspectSymbols(args, filePath, targetPathHint)
        : selection.operation !== 'contract' && selection.operation !== 'audit_events'
          ? await inspectSource(args, filePath, targetPathHint) : undefined;
      if (selected) return selected;

      // Sub-action B: Public interface contract with optional event handler audit
      const auditEvents = Boolean(args.audit_events || args.auditEvents);
      const wsRoot = targetPathHint ? resolveWorkspacePath(targetPathHint) : resolveProjectOwnership(filePath).ownerRoot ?? findProjectRoot(filePath);

      let primary = await readSourceSnapshot(filePath);
      let contract: ComponentContract | null = null;
      let omissions: Array<{ code: string; reason: string }> = [];
      let auditResult: any = null;
      let retrieval: RetrievalEvidence | null = null;
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        omissions = [];
        primary = await readSourceSnapshot(filePath);
        contract = await extractComponentContract(filePath, primary.content, { workspaceRoot: wsRoot });
        const boundaryOmission = renderBoundaryOmission(contract.renderBoundary);
        if (boundaryOmission) omissions.push(boundaryOmission);
        omissions.push(...(contract.projectContext?.diagnostics ?? []));

        if (contract.unresolvedTypes && contract.unresolvedTypes.length > 0) {
          for (const unres of contract.unresolvedTypes) {
            omissions.push({
              code: unres.kind === 'props' ? 'UNRESOLVED_PROPS_TYPE' : 'UNRESOLVED_TYPE',
              reason: `${unres.name}: ${unres.reason}`,
            });
          }
        }
        omissions.push(...(contract.stateDependencies?.diagnostics ?? []));

        for (const [owner, metadata] of [['NUXT_PAGE_META', contract.nuxtPageMeta], ['NEXT_SEGMENT_CONFIG', contract.nextSegmentConfig]] as const) {
          for (const field of metadata?.unresolvedFields ?? []) omissions.push({
            code: `${owner}_UNRESOLVED`, reason: `${field.field}: ${field.reason} (${field.expression})`,
          });
        }

        if (filePath.endsWith('.vue')) {
          const templateIssue = inspectVueTreeInput(primary.content, filePath);
          if (templateIssue) {
            omissions.push({
              code: templateIssue.code,
              reason: templateIssue.reason,
            });
          }
        }

        if (auditEvents) {
          auditResult = await auditEventHandlers({ path: filePath });
          omissions.push(...(auditResult.autoImportUnresolved ?? []).map((reason: string) => ({ code: 'NUXT_AUTO_IMPORT_PARTIAL', reason })));
          const dependencies = new Map((contract.dependencies ?? []).map(dependency => [dependency.path, dependency]));
          for (const dependency of auditResult.autoImportDependencies ?? []) {
            if (dependencies.has(dependency.path) && dependencies.get(dependency.path)!.hash !== dependency.hash) {
              omissions.push({ code: 'DEPENDENCY_CHANGED', reason: `${dependency.path}: dependency changed between contract and event audit reads` });
            }
            dependencies.set(dependency.path, dependency);
          }
          contract.dependencies = [...dependencies.values()];
        }

        if (impact !== 'none') {
          contract.propImpact = await analyzePropImpact({ target: filePath, workspace: wsRoot, props: contract.props, detail: impact });
          omissions.push({ code: 'PROP_IMPACT_PARTIAL', reason: 'Prop impact counts cover observed static Vue and React/JSX usages only; unknown consumers and input closure remain unverified.' });
          omissions.push(...contract.propImpact.diagnostics.map(item => ({ code: item.code, reason: `${item.file}: ${item.reason}` })));
        }

        // Check if secondary dependencies or primary snapshot mutated during analysis
        let hasConcurrentMutation = contract.propImpact?.freshness === 'stale' || omissions.some(item => item.code === 'DEPENDENCY_CHANGED');
        if (contract.dependencies && contract.dependencies.length > 0) {
          for (const dep of contract.dependencies) {
            try {
              if (!fs.existsSync(dep.path)) {
                hasConcurrentMutation = true;
                break;
              }
              const currentContent = await readSourceFile(dep.path);
              const currentHash = createHash('sha256').update(currentContent).digest('hex');
              if (currentHash !== dep.hash) {
                hasConcurrentMutation = true;
                break;
              }
            } catch {
              hasConcurrentMutation = true;
              break;
            }
          }
        }

        try {
          const rechecked = await readSourceSnapshot(filePath);
          if (rechecked.snapshot.sha256 !== primary.snapshot.sha256) {
            hasConcurrentMutation = true;
          }
        } catch {
          hasConcurrentMutation = true;
        }

        if (hasConcurrentMutation && attempt < maxAttempts) {
          // Conservative retry on concurrent mutation
          continue;
        }

        if (hasConcurrentMutation) {
          omissions.push({
            code: 'CONCURRENT_MUTATION_DETECTED',
            reason: 'Concurrent mutation detected on source or secondary dependency during analysis; retried once but changes persisted.',
          });
        }

        let configFingerprint: string | undefined;
        try {
          const { configFiles } = await loadAliasConfigWithDependencies(filePath);
          if (configFiles.length > 0) {
            const ch = createHash('sha256');
            for (const cf of configFiles.sort()) {
              try {
                const cfContent = await readSourceFile(cf);
                ch.update(cf).update('\0').update(createHash('sha256').update(cfContent).digest('hex'));
              } catch {}
            }
            configFingerprint = ch.digest('hex');
          }
        } catch {}

        const evidenceOptions = {
          workspace: wsRoot,
          snapshot: primary.snapshot,
          policy: 'component-contract-v1',
          query: { auditEvents, impact },
          complete: omissions.length === 0,
          selectionReason: 'Derived public component contract and diagnostics for the explicitly requested file.',
          omissions,
          dependencies: contract.dependencies,
          configFingerprint,
        };

        retrieval = await derivedRetrievalEvidence(evidenceOptions);
        if (hasConcurrentMutation) retrieval.freshness = 'stale';
        break;
      }

      if (auditEvents) {
        if (isJson) {
          return {
            structuredContent: { ...contract, eventAudit: auditResult, retrieval },
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ...contract,
                    eventAudit: auditResult,
                    retrieval,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const contractText = formatContractAsText(contract!);
        const auditText = formatEventHandlerAuditAsText(auditResult);
        return {
          structuredContent: { ...contract, eventAudit: auditResult, retrieval },
          content: [
            {
              type: 'text',
              text: `${contractText}\n\n${auditText}\n\n${formatRetrievalEvidence(retrieval!)}`,
            },
          ],
        };
      }

      const contractText = [formatContractAsText(contract!), contract?.propImpact ? formatPropImpactAsText(contract.propImpact) : '',
        formatRetrievalEvidence(retrieval!)].filter(Boolean).join('\n\n');
      return {
        structuredContent: { ...contract, retrieval },
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify({ ...contract, retrieval }) : contractText,
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to inspect component "${filePath}": ${msg}` }],
      };
    }
  },
};

export const inspectComponentTool: McpToolDefinition = withRetrievalEvidence(inspectComponentToolDefinition, {
  formatText: (data, page) => {
    if (page.path === 'functions' && Array.isArray(data.functions)) {
      return formatOutlineAsText(data as any);
    }
    if (page.path === 'regions' && Array.isArray(data.regions) && data.snapshot) {
      return formatSourceMapAsText(data as any);
    }
    if (page.path === 'blocks' && Array.isArray(data.blocks) && data.file) {
      return formatSfcSectionsAsText(String(data.file), data.blocks);
    }
    if (page.path === 'propImpact.props' && Array.isArray(data.props) && data.propImpact) {
      return [formatContractAsText(data as any), formatPropImpactAsText(data.propImpact)].filter(Boolean).join('\n\n');
    }
    return undefined;
  },
});
