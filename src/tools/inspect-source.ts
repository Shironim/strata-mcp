import { extname } from 'node:path';
import { resolveWorkspacePath, findProjectRoot, parseSafePositiveInt } from '../engine/path-resolver';
import { getSourceLineRange, readSourceSnapshot, readSourceRef, sliceSourceSnapshot } from '../engine/source-file';
import { sourceRetrievalEvidence, formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { mapSourceFile, formatSourceMapAsText } from '../engine/source-map';
import { parseSfc } from '../engine/splitter';
import { inspectVueTreeInput } from '../engine/graph/vue-tree-input';
import type { SourceRef } from '../types';
import type { ToolCallResponse } from './types';

export interface InspectSourceRequest {
  view?: 'map' | 'source';
  source_ref?: SourceRef;
  source_range?: { start_line: number; end_line: number };
  format?: string;
  [key: string]: unknown;
}

export async function inspectSource(args: InspectSourceRequest, filePath: string, targetPathHint?: string): Promise<ToolCallResponse | undefined> {
  const isJson = args.format === 'json';
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
    return { structuredContent: { ...result, retrieval }, content: [{ type: 'text', text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatSourceMapAsText(result)}\n${formatRetrievalEvidence(retrieval)}` }] };
  }

  if (args.view === 'source' && args.source_ref) {
    const { snapshot, content } = await readSourceSnapshot(filePath);
    const source = sliceSourceSnapshot(snapshot, content, args.source_ref);
    const wantsStructured = isJson || Boolean(args.include_structured || args.includeStructured);
    const retrieval = await sourceRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot,
      policy: 'exact-source-ref-v1', query: { source_ref: args.source_ref }, complete: true, selectionReason: 'Exact hash-bound source reference explicitly requested by the caller.' });
    return {
      structuredContent: {
        file: filePath,
        source_ref: args.source_ref,
        ...(wantsStructured ? { source } : {}),
        retrieval,
      },
      content: isJson
        ? [{ type: 'text', text: JSON.stringify({ file: filePath, source_ref: args.source_ref, source, retrieval }, null, 2) }]
        : [{ type: 'text', text: source }, { type: 'text', text: formatRetrievalEvidence(retrieval) }],
    };
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
    const actualStartLine = selected.lineRange.startLine;
    const actualEndLine = selected.lineRange.endLine;
    const source = await readSourceRef(filePath, selected.ref);
    const wantsStructured = isJson || Boolean(args.include_structured || args.includeStructured);
    const clampNote = selected.clamped ? `clamped to EOF (L${actualEndLine}; requested L${endLine})` : undefined;
    const retrieval = await sourceRetrievalEvidence({
      workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath),
      snapshot,
      policy: 'inclusive-line-range-v1',
      query: {
        startLine: actualStartLine,
        endLine: actualEndLine,
        ...(selected.clamped ? { requestedEndLine: endLine } : {}),
        expectedHash: expectedHash ?? null,
      },
      complete: true,
      selectionReason: clampNote
        ? `Inclusive source line range explicitly requested by the caller (${clampNote}).`
        : 'Inclusive source line range explicitly requested by the caller.',
    });
    const rangeMeta = {
      file: filePath,
      startLine: actualStartLine,
      endLine: actualEndLine,
      ...(selected.clamped ? { clamped: true, requestedEndLine: endLine } : {}),
      source_ref: selected.ref,
      retrieval,
    };
    return {
      content: [{
        type: 'text',
        text: isJson
          ? JSON.stringify({ ...rangeMeta, source }, null, 2)
          : source,
      }, ...(!isJson ? [{ type: 'text' as const, text: formatRetrievalEvidence(retrieval) }] : [])],
      structuredContent: wantsStructured ? { ...rangeMeta, source } : rangeMeta,
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
          : `${formatSfcSectionsAsText(filePath, blocks)}\n${formatRetrievalEvidence(retrieval)}`,
      }],
    };
  }


}

export function formatSfcSectionsAsText(
  filePath: string,
  blocks: Array<{
    index: number;
    type: string;
    sourceStartLine: number;
    sourceEndLine: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>
): string {
  return [
    `Vue SFC blocks in ${filePath}:`,
    ...blocks.map(
      block =>
        `- Block ${block.index} (${block.type}): lines ${block.sourceStartLine}-${block.sourceEndLine}; content starts at ${block.startLine}:${block.startColumn}, ends before ${block.endLine}:${block.endColumn}`
    ),
    'Use source_range with inclusive start_line/end_line to retrieve exact file lines.',
  ].join('\n');
}
