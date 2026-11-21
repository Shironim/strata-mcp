import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseVueSfc } from '@vue/compiler-sfc';
import { parseAstro } from '../astro-sfc';
import { parseSvelte } from '../svelte-sfc';
import { getSourcePosition } from '../../utils/source-position';
import { canonicalizePath } from '../path-resolver';
import type { QueryEnvelope, ServiceRuntimeOptions } from './contracts';
import { NotFoundError, StaleSourceError, ValidationError } from './errors';
import { syncWorkspaceV3 } from './fast-sync';
import { defaultWarmDbPool } from './schema-v3';
import {
  formatSourceRef,
  parseSourceRef,
  resolvePathWithinWorkspace,
  shortHash,
} from './source-ref';

export type SourceBlockKind = 'script' | 'scriptSetup' | 'template' | 'style';

export interface ReadSliceRequest extends ServiceRuntimeOptions {
  workspaceRoot: string;
  sourceRef?: string;
  symbolId?: string;
  path?: string;
  symbol?: string;
  block?: SourceBlockKind;
  lines?: [number, number];
  contextLines?: number;
  maxLines?: number;
}

export interface SourceSliceData {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  sourceRef: string;
  content: string;
}

/**
 * Selective Source Reading Service:
 * Reads bounded, hash-verified slices by sourceRef, symbolId, SFC block, or explicit line range.
 */
export async function readSlice(
  request: ReadSliceRequest
): Promise<QueryEnvelope<SourceSliceData>> {
  const absRoot = canonicalizePath(request.workspaceRoot);
  const contextLines = Math.max(0, Math.min(20, Math.trunc(request.contextLines ?? 2)));
  const maxLines = Math.max(1, Math.min(400, Math.trunc(request.maxLines ?? 80)));

  let targetFile: string;
  let startOffset: number | null = null;
  let endOffset: number | null = null;
  let expectedHashPrefix: string | null = null;
  let explicitLines: [number, number] | null = null;

  if (request.sourceRef) {
    const parsed = parseSourceRef(request.sourceRef);
    targetFile = resolvePathWithinWorkspace(absRoot, parsed.filePath);
    startOffset = parsed.startOffset;
    endOffset = parsed.endOffset;
    expectedHashPrefix = parsed.hashPrefix;
  } else if (request.symbolId) {
    const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });
    if (!request.skipSync) {
      await syncWorkspaceV3(absRoot, { db });
    }
    const row = db
      .query(
        `SELECT f.path AS file_path, s.start_offset, s.end_offset
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.symbol_uid = ?`
      )
      .get(request.symbolId) as {
      file_path: string;
      start_offset: number;
      end_offset: number;
    } | null;

    if (!row) {
      throw new NotFoundError(`Symbol not found: "${request.symbolId}"`);
    }
    targetFile = resolvePathWithinWorkspace(absRoot, row.file_path);
    startOffset = row.start_offset;
    endOffset = row.end_offset;
  } else if (request.path) {
    targetFile = resolvePathWithinWorkspace(absRoot, request.path);

    if (request.symbol) {
      const db = request.db ?? defaultWarmDbPool.get(absRoot, { dbFilename: request.dbFilename });
      if (!request.skipSync) {
        await syncWorkspaceV3(absRoot, { db });
      }
      const row = db
        .query(
          `SELECT s.start_offset, s.end_offset
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE f.path = ? AND s.name = ?
           ORDER BY s.start_offset ASC
           LIMIT 1`
        )
        .get(targetFile, request.symbol) as {
        start_offset: number;
        end_offset: number;
      } | null;
      if (!row) {
        throw new NotFoundError(`Symbol "${request.symbol}" not found in "${targetFile}".`);
      }
      startOffset = row.start_offset;
      endOffset = row.end_offset;
    } else if (request.block) {
      if (!existsSync(targetFile)) {
        throw new NotFoundError(`File not found: "${targetFile}"`);
      }
      const raw = readFileSync(targetFile, 'utf8');
      const blockRange = locateSfcBlock(targetFile, raw, request.block);
      if (!blockRange) {
        throw new NotFoundError(`Block "${request.block}" not found in "${targetFile}".`);
      }
      startOffset = blockRange.start;
      endOffset = blockRange.end;
    } else if (request.lines) {
      const [s, e] = request.lines;
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) {
        throw new ValidationError(`Invalid lines range [${s}, ${e}]. Expected 1-based [start, end] with start <= end.`);
      }
      explicitLines = [s, e];
    } else {
      explicitLines = [1, maxLines];
    }
  } else {
    throw new ValidationError('Provide one of: sourceRef, symbolId, or path.');
  }

  if (!existsSync(targetFile)) {
    throw new NotFoundError(`File not found: "${targetFile}"`);
  }

  const rawContent = readFileSync(targetFile, 'utf8');
  const currentHash = shortHash(rawContent);

  if (expectedHashPrefix && expectedHashPrefix !== currentHash) {
    throw new StaleSourceError(
      `Source file "${targetFile}" changed on disk since sourceRef was issued (expected ${expectedHashPrefix}, actual ${currentHash}). Re-run inspect_file or query_graph to obtain a fresh sourceRef.`,
      { filePath: targetFile, expectedHashPrefix, actualHashPrefix: currentHash }
    );
  }

  const allLines = rawContent.split('\n');
  const totalLines = allLines.length;

  let sliceStartLine: number;
  let sliceEndLine: number;

  if (explicitLines) {
    sliceStartLine = Math.max(1, explicitLines[0]);
    sliceEndLine = Math.min(totalLines, explicitLines[1]);
  } else {
    const sPos = getSourcePosition(rawContent, startOffset ?? 0);
    const ePos = getSourcePosition(rawContent, endOffset ?? startOffset ?? 0);
    sliceStartLine = Math.max(1, sPos.line - contextLines);
    sliceEndLine = Math.min(totalLines, Math.max(sPos.line, ePos.line) + contextLines);
  }

  let truncated = false;
  if (sliceEndLine - sliceStartLine + 1 > maxLines) {
    sliceEndLine = sliceStartLine + maxLines - 1;
    truncated = true;
  }

  const numberedLines: string[] = [];
  for (let lineNum = sliceStartLine; lineNum <= sliceEndLine; lineNum++) {
    numberedLines.push(`${lineNum}: ${allLines[lineNum - 1] ?? ''}`);
  }

  const outStartOffset = startOffset ?? computeLineStartOffset(allLines, sliceStartLine);
  const outEndOffset = endOffset ?? computeLineEndOffset(allLines, sliceEndLine);

  return {
    scope: targetFile,
    verification: 'graph',
    data: {
      filePath: targetFile,
      startLine: sliceStartLine,
      endLine: sliceEndLine,
      totalLines,
      truncated,
      sourceRef: formatSourceRef(targetFile, currentHash, outStartOffset, outEndOffset),
      content: numberedLines.join('\n'),
    },
    omissions: [],
    diagnostics: truncated
      ? [
          {
            code: 'SLICE_TRUNCATED',
            message: `Output capped at ${maxLines} lines (${sliceStartLine}-${sliceEndLine} of ${totalLines}). Pass lines=[${sliceEndLine + 1}, ${Math.min(totalLines, sliceEndLine + maxLines)}] to continue.`,
            filePath: targetFile,
          },
        ]
      : [],
  };
}

function locateSfcBlock(
  filePath: string,
  raw: string,
  block: SourceBlockKind
): { start: number; end: number } | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.vue') {
    const { descriptor } = parseVueSfc(raw, { filename: filePath, pad: false });
    if (block === 'script' && descriptor.script) {
      return { start: descriptor.script.loc.start.offset, end: descriptor.script.loc.end.offset };
    }
    if (block === 'scriptSetup' && descriptor.scriptSetup) {
      return { start: descriptor.scriptSetup.loc.start.offset, end: descriptor.scriptSetup.loc.end.offset };
    }
    if (block === 'template' && descriptor.template) {
      return { start: descriptor.template.loc.start.offset, end: descriptor.template.loc.end.offset };
    }
    if (block === 'style' && descriptor.styles[0]) {
      return { start: descriptor.styles[0].loc.start.offset, end: descriptor.styles[0].loc.end.offset };
    }
    return null;
  }
  if (ext === '.svelte') {
    const desc = parseSvelte(raw, filePath);
    if (block === 'script' && desc.module) {
      return { start: desc.module.loc.start.offset, end: desc.module.loc.end.offset };
    }
    if ((block === 'scriptSetup' || block === 'script') && desc.instance) {
      return { start: desc.instance.loc.start.offset, end: desc.instance.loc.end.offset };
    }
    if (block === 'template' && desc.template) {
      return { start: desc.template.loc.start.offset, end: desc.template.loc.end.offset };
    }
    if (block === 'style' && desc.styles?.[0]) {
      return { start: desc.styles[0].loc.start.offset, end: desc.styles[0].loc.end.offset };
    }
    return null;
  }
  if (ext === '.astro') {
    const desc = parseAstro(raw, filePath);
    if ((block === 'scriptSetup' || block === 'script') && desc.frontmatter) {
      return { start: desc.frontmatter.loc.start.offset, end: desc.frontmatter.loc.end.offset };
    }
    if (block === 'template' && desc.template) {
      return { start: desc.template.loc.start.offset, end: desc.template.loc.end.offset };
    }
    return null;
  }
  return null;
}

function computeLineStartOffset(lines: readonly string[], line1Based: number): number {
  let offset = 0;
  for (let i = 0; i < line1Based - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset;
}

function computeLineEndOffset(lines: readonly string[], line1Based: number): number {
  let offset = 0;
  for (let i = 0; i < line1Based && i < lines.length; i++) {
    offset += lines[i].length + (i < line1Based - 1 ? 1 : 0);
  }
  return offset;
}
