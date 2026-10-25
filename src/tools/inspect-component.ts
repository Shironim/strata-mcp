import { TOOL_CATALOG } from './catalog';
import fs from 'node:fs';
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
import { getSourceLineRange, readSourceFile, readSourceSnapshot, readSourceRef } from '../engine/source-file';
import { mapSourceFile } from '../engine/source-map';
import { parseSfc } from '../engine/splitter';
import { runCanonAudit } from '../engine/canon';
import type { McpToolDefinition } from './types';

export const inspectComponentTool: McpToolDefinition = {
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
        const result = await mapSourceFile(filePath, { maxRegions: parseSafePositiveInt(args.max_regions ?? args.maxRegions, 200) });
        return { content: [{ type: 'text', text: isJson ? JSON.stringify(result, null, 2) : formatSourceMap(result) }] };
      }

      if (args.view === 'source' && args.source_ref) {
        const source = await readSourceRef(filePath, args.source_ref);
        return { content: [{ type: 'text', text: isJson ? JSON.stringify({ file: filePath, source_ref: args.source_ref, source }, null, 2) : source }] };
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
        return {
          content: [{
            type: 'text',
            text: isJson
              ? JSON.stringify({ file: filePath, startLine, endLine, source_ref: selected.ref, source }, null, 2)
              : source,
          }],
        };
      }

      if (args.sfc_sections) {
        if (extname(filePath).toLowerCase() !== '.vue') {
          return { isError: true, content: [{ type: 'text', text: "'sfc_sections' is only available for .vue files." }] };
        }
        const descriptor = parseSfc(await readSourceFile(filePath), filePath);
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
        return {
          content: [{
            type: 'text',
            text: isJson
              ? JSON.stringify({ file: filePath, blocks }, null, 2)
              : [`Vue SFC blocks in ${filePath}:`, ...blocks.map(block =>
                  `- Block ${block.index} (${block.type}): lines ${block.sourceStartLine}-${block.sourceEndLine}; content starts at ${block.startLine}:${block.startColumn}, ends before ${block.endLine}:${block.endColumn}`),
                'Use source_range with inclusive start_line/end_line to retrieve exact file lines.'].join('\n'),
          }],
        };
      }

      // Sub-action A0: Component Symbol Outline with line ranges & callee mappings
      if (isOutline) {
        const outlineResult = await extractComponentOutline(filePath, {
          path: filePath,
          maxFunctionLines: args.max_function_lines ? Number(args.max_function_lines) : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(outlineResult, null, 2) : formatOutlineAsText(outlineResult),
            },
          ],
        };
      }

      // Sub-action A: Symbol slicing
      if (symbolName) {
        const result = await sliceSymbol({
          path: filePath,
          symbolName: String(symbolName),
          includeBlastRadius: true,
        });
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol '${symbolName}' not found in '${filePath}'.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatSymbolSliceAsText(result),
            },
          ],
        };
      }

      // Sub-action B: Public interface contract with reactivity smells & optional event handler audit
      const inferProps = args.infer_props !== false && args.inferProps !== false;
      const resolveGlobals = args.resolve_globals !== false && args.resolveGlobals !== false;
      const auditEvents = Boolean(args.audit_events || args.auditEvents);
      const contract = await extractComponentContract(filePath, { inferProps, resolveGlobals });

      // Detect Reactivity Smells directly as first-class diagnostics
      const reactivitySmells = await detectReactivitySmells({ path: filePath });
      contract.reactivitySmells = reactivitySmells;

      try {
        const { snapshot, content } = await readSourceSnapshot(filePath);
        contract.patternDiagnostics = await runCanonAudit(snapshot, content);
      } catch {
        // Source snapshot error safe fallback
      }

      if (auditEvents) {
        const auditResult = await auditEventHandlers({ path: filePath });
        if (isJson) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ...contract,
                    eventAudit: auditResult,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const contractText = formatContractAsText(contract);
        const auditText = formatEventHandlerAuditAsText(auditResult);
        return {
          content: [
            {
              type: 'text',
              text: `${contractText}\n\n${auditText}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(contract, null, 2) : formatContractAsText(contract),
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

