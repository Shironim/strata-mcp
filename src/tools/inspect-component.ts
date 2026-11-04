import { TOOL_CATALOG } from './catalog';
import { withRetrievalEvidence } from './retrieval-response';
import { renderBoundaryOmission } from './boundary-evidence';
import { resolveProjectOwnership } from '../engine/project-ownership';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, relative, isAbsolute, resolve } from 'node:path';
import { collectFiles } from '../engine/collector';
import { sliceSymbol, formatSymbolSliceAsText } from '../engine/slicer';
import {
  auditEventHandlers,
  formatEventHandlerAuditAsText,
  detectReactivitySmells,
  formatReactivitySmellsAsText,
} from '../engine/reactivity';
import { extractComponentContract, formatContractAsText } from '../engine/contract';
import { extractComponentOutline, formatOutlineAsText } from '../engine/outline';
import { resolveWorkspacePath, findProjectRoot, PROJECT_ROOT_MARKERS, parseSafePositiveInt } from '../engine/path-resolver';
import { getSourceLineRange, readSourceSnapshot, readSourceRef, sliceSourceSnapshot, readSourceFile } from '../engine/source-file';
import { sourceRetrievalEvidence, derivedRetrievalEvidence, formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { mapSourceFile } from '../engine/source-map';
import { parseSfc } from '../engine/splitter';
import { runCanonAudit } from '../engine/canon';
import { inspectVueTreeInput } from '../engine/graph/vue-tree-input';
import { loadAliasConfigWithDependencies } from '../engine/resolver';
import { analyzePropImpact, formatPropImpactAsText } from '../engine/prop-impact';
import type { ComponentContract, RetrievalEvidence } from '../types';
import type { McpToolDefinition } from './types';

const inspectComponentToolDefinition: McpToolDefinition = {
  ...TOOL_CATALOG[1],
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
    const symbolName = args.symbol || args.symbol_name;
    const isOutline = Boolean(args.outline || args.include_outline || args.outline_symbols);
    const view = args.view;
    const impact = args.impact ?? 'none';
    if (!['none', 'summary', 'full'].includes(impact)) {
      return { isError: true, content: [{ type: 'text', text: "'impact' must be 'none', 'summary', or 'full'." }] };
    }
    if (impact !== 'none' && (view || symbolName || isOutline || args.source_range !== undefined || args.sfc_sections || args.audit_events || args.auditEvents)) {
      return { isError: true, content: [{ type: 'text', text: "'impact' applies only to component contract inspection; remove other selectors." }] };
    }
    if (view !== undefined && !['map', 'source'].includes(view)) {
      return { isError: true, content: [{ type: 'text', text: "'view' must be 'map' or 'source'." }] };
    }
    if (view && (symbolName || isOutline || args.source_range !== undefined || args.sfc_sections || args.audit_events)) {
      return { isError: true, content: [{ type: 'text', text: "'view' cannot be combined with symbol, outline, source_range, sfc_sections, or audit_events selectors." }] };
    }
    const legacySelectorCount = [Boolean(symbolName), isOutline, args.source_range !== undefined, Boolean(args.sfc_sections), Boolean(args.audit_events)].filter(Boolean).length;
    if (!view && legacySelectorCount > 1) {
      return { isError: true, content: [{ type: 'text', text: 'Use only one of symbol, outline, source_range, sfc_sections, or audit_events per inspect request.' }] };
    }
    if (args.source_ref && view !== 'source') {
      return { isError: true, content: [{ type: 'text', text: "'source_ref' requires 'view: source'." }] };
    }
    if ((args.expected_hash ?? args.expectedHash) && args.source_range === undefined) {
      return { isError: true, content: [{ type: 'text', text: "'expected_hash' requires 'source_range'." }] };
    }

    try {
      if (args.view === 'map') {
        const maxRegions = Math.min(500, parseSafePositiveInt(args.max_regions ?? args.maxRegions, 200) ?? 200);
        const result = await mapSourceFile(filePath, { maxRegions });
        const primary = await readSourceSnapshot(filePath);
        const templateIssue = filePath.endsWith('.vue') ? inspectVueTreeInput(primary.content, filePath) : null;
        if (templateIssue) {
          result.diagnostics.push({
            code: templateIssue.code,
            message: templateIssue.reason,
          });
        }
        const retrieval = await sourceRetrievalEvidence({
          workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot: result.snapshot,
          policy: 'file-map-v1', query: { maxRegions },
          complete: result.status === 'complete' && !templateIssue, selectionReason: 'Source regions of the explicitly requested file, bounded by max_regions and parser capability.',
          omissions: [...result.diagnostics.map(d => ({ code: d.code, reason: d.message })), ...result.unsupported.map(reason => ({ code: 'UNSUPPORTED_CAPABILITY', reason }))],
        });
        return { structuredContent: { ...result, retrieval }, content: [{ type: 'text', text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatSourceMap(result)}\n${formatRetrievalEvidence(retrieval)}` }] };
      }

      if (args.view === 'source' && args.source_ref) {
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const source = sliceSourceSnapshot(snapshot, content, args.source_ref);
        const retrieval = await sourceRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot,
          policy: 'exact-source-ref-v1', query: { source_ref: args.source_ref }, complete: true, selectionReason: 'Exact hash-bound source reference explicitly requested by the caller.' });
        return { structuredContent: { file: filePath, source_ref: args.source_ref, source, retrieval }, content: isJson
          ? [{ type: 'text', text: JSON.stringify({ file: filePath, source_ref: args.source_ref, source, retrieval }, null, 2) }]
          : [{ type: 'text', text: source }, { type: 'text', text: formatRetrievalEvidence(retrieval) }] };
      }
      if (args.view === 'source') {
        return { isError: true, content: [{ type: 'text', text: "'view: source' requires a source_ref returned by 'view: map'." }] };
      }

      if (args.source_range !== undefined) {
        const { start_line: startLine, end_line: endLine } = args.source_range || {};
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
          return { isError: true, content: [{ type: 'text', text: "'source_range' requires positive integer start_line and end_line, with end_line >= start_line." }] };
        }
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const expectedHash = args.expected_hash ?? args.expectedHash;
        if (expectedHash && expectedHash !== snapshot.sha256) {
          const stalePayload = {
            status: 'stale',
            file: filePath,
            expected_hash: expectedHash,
            current_hash: snapshot.sha256,
            action_required: "inspect_component(view: 'map')",
            message: "STALE_SOURCE_REF: expected_hash does not match current source. Re-run with view: 'map' to obtain fresh source_refs.",
          };
          return {
            isError: true,
            content: [{
              type: 'text',
              text: isJson ? JSON.stringify(stalePayload, null, 2) : stalePayload.message,
            }],
          };
        }
        const selected = getSourceLineRange(snapshot, content, startLine, endLine);
        const source = await readSourceRef(filePath, selected.ref);
        const retrieval = await sourceRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot,
          policy: 'inclusive-line-range-v1', query: { startLine, endLine, expectedHash: expectedHash ?? null }, complete: true,
          selectionReason: 'Inclusive source line range explicitly requested by the caller.' });
        return {
          content: [{
            type: 'text',
            text: isJson
              ? JSON.stringify({ file: filePath, startLine, endLine, source_ref: selected.ref, source, retrieval }, null, 2)
              : source,
          }, ...(!isJson ? [{ type: 'text' as const, text: formatRetrievalEvidence(retrieval) }] : [])],
          structuredContent: { file: filePath, startLine, endLine, source_ref: selected.ref, source, retrieval },
        };
      }

      if (args.sfc_sections) {
        if (extname(filePath).toLowerCase() !== '.vue') {
          return { isError: true, content: [{ type: 'text', text: "'sfc_sections' is only available for .vue files." }] };
        }
        const primary = await readSourceSnapshot(filePath);
        const descriptor = parseSfc(primary.content, filePath);
        const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template, ...descriptor.styles, ...descriptor.customBlocks]
          .filter((block): block is NonNullable<typeof block> => Boolean(block))
          .sort((a, b) => a.loc.start.offset - b.loc.start.offset)
          .map((block, index) => ({
            index: index + 1,
            type: block.type,
            sourceStartLine: block.loc.start.line,
            sourceEndLine: Math.max(block.loc.start.line, block.loc.end.line - (block.loc.end.column === 1 ? 1 : 0)),
            startLine: block.loc.start.line,
            startColumn: block.loc.start.column,
            endLine: block.loc.end.line,
            endColumn: block.loc.end.column,
            endIsExclusive: true,
          }));
        const retrieval = await sourceRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot: primary.snapshot,
          policy: 'sfc-sections-v1', query: {}, complete: !descriptor.diagnostics?.length, selectionReason: 'All source block boundaries of the explicitly requested Vue SFC.',
          omissions: descriptor.diagnostics?.map(d => ({ code: d.code, reason: d.message })) });
        return {
          structuredContent: { file: filePath, blocks, retrieval },
          content: [{
            type: 'text',
            text: isJson
              ? JSON.stringify({ file: filePath, blocks, retrieval }, null, 2)
              : [`Vue SFC blocks in ${filePath}:`, ...blocks.map(block =>
                  `- Block ${block.index} (${block.type}): lines ${block.sourceStartLine}-${block.sourceEndLine}; content starts at ${block.startLine}:${block.startColumn}, ends before ${block.endLine}:${block.endColumn}`),
                'Use source_range with inclusive start_line/end_line to retrieve exact file lines.', formatRetrievalEvidence(retrieval)].join('\n'),
          }],
        };
      }

      // Sub-action A0: Component Symbol Outline with line ranges & callee mappings
      if (isOutline) {
        const primary = await readSourceSnapshot(filePath);
        const outlineResult = await extractComponentOutline(filePath, {
          path: filePath,
          maxFunctionLines: args.max_function_lines ? Number(args.max_function_lines) : undefined,
        });

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

        const retrieval = await derivedRetrievalEvidence({
          workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath),
          snapshot: primary.snapshot,
          policy: 'component-outline-v1',
          query: { maxFunctionLines: args.max_function_lines ? Number(args.max_function_lines) : null },
          complete: false,
          selectionReason: 'Requested symbol outline and derived cross-file mappings; analyzer may read additional source versions.',
          dependencies: outlineResult.dependencies,
          configFingerprint,
        });
        return {
          structuredContent: { ...outlineResult, retrieval },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify({ ...outlineResult, retrieval }, null, 2) : `${formatOutlineAsText(outlineResult)}\n\n${formatRetrievalEvidence(retrieval)}`,
            },
          ],
        };
      }

      // Sub-action A: Symbol slicing
      if (symbolName) {
        const primary = await readSourceSnapshot(filePath);
        const result = await sliceSymbol({
          path: filePath,
          symbolName: String(symbolName),
          workspaceRoot: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath),
          includeBlastRadius: true,
        });
        const retrieval = await derivedRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot: primary.snapshot,
          policy: 'symbol-slice-v1', query: { symbolName: String(symbolName), includeBlastRadius: true }, complete: false,
          selectionReason: 'Requested named symbol and derived caller information; analyzer may read additional source versions.' });
        if (!result) {
          return {
            structuredContent: { file: filePath, found: false, symbol: String(symbolName), retrieval },
            content: [
              {
                type: 'text',
                text: isJson ? JSON.stringify({ file: filePath, found: false, symbol: String(symbolName), retrieval }, null, 2) : `Symbol '${symbolName}' not found in '${filePath}'.\n${formatRetrievalEvidence(retrieval)}`,
              },
            ],
          };
        }
        return {
          structuredContent: { ...result, retrieval },
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatSymbolSliceAsText(result)}\n\n${formatRetrievalEvidence(retrieval)}`,
            },
          ],
        };
      }

      // Sub-action B: Public interface contract with reactivity smells & optional event handler audit
      const inferProps = args.infer_props !== false && args.inferProps !== false;
      const resolveGlobals = args.resolve_globals !== false && args.resolveGlobals !== false;
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
        contract = await extractComponentContract(filePath, primary.content, { inferProps, resolveGlobals, workspaceRoot: wsRoot });
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

        // Detect Reactivity Smells directly as first-class diagnostics
        const reactivitySmells = await detectReactivitySmells({ path: filePath });
        contract.reactivitySmells = reactivitySmells;

        try {
          contract.patternDiagnostics = await runCanonAudit(primary.snapshot, primary.content,
            contract.framework === 'vue-composable' ? 'vue' : contract.framework as import('../types').FrontendFramework,
            { projectContext: contract.projectContext, projectRoot: wsRoot });
        } catch (error) {
          omissions.push({ code: 'PATTERN_AUDIT_FAILED', reason: error instanceof Error ? error.message : String(error) });
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
          query: { inferProps, resolveGlobals, auditEvents, impact },
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
            text: isJson ? JSON.stringify({ ...contract, retrieval }, null, 2) : contractText,
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

export const inspectComponentTool: McpToolDefinition = withRetrievalEvidence(inspectComponentToolDefinition);

function formatSourceMap(result: Awaited<ReturnType<typeof mapSourceFile>>): string {
  const lines = [`${result.framework} map: ${result.snapshot.file}`, `Status: ${result.status}`];
  for (const item of result.regions) {
    const range = item.lineRange ? `${item.lineRange.startLine}-${item.lineRange.endLine}` : 'empty';
    lines.push(`- ${item.kind}${item.name ? ` ${item.name}` : ''}: lines ${range} (source_ref ${item.ref.sha256.slice(0, 12)}:${item.ref.startOffset}-${item.ref.endOffset})`);
    for (const child of item.children ?? []) {
      const childRange = child.lineRange ? `${child.lineRange.startLine}-${child.lineRange.endLine}` : 'empty';
      lines.push(`  - ${child.kind}: lines ${childRange} (source_ref ${child.ref.sha256.slice(0, 12)}:${child.ref.startOffset}-${child.ref.endOffset})`);
    }
  }
  for (const diagnostic of result.diagnostics) lines.push(`! ${diagnostic.code}: ${diagnostic.message}`);
  if (result.coverage?.truncated || result.coverage?.childRegionsTruncated) lines.push(`Truncated: ${JSON.stringify(result.coverage)}`);
  if (result.unsupported.length) lines.push(`Unsupported: ${result.unsupported.join(', ')}`);
  return lines.join('\n');
}

