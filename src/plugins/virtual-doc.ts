import { createHash } from 'node:crypto';
import type {
  FrontendFrameworkId,
  OriginalSpan,
  ProjectionOmission,
  VirtualDocument,
  VirtualSegment,
  VirtualSegmentKind,
} from './types';

export function hashSourceContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildVirtualPath(originalPath: string, isIdentity: boolean): string {
  return isIdentity ? originalPath : `${originalPath}.__strata__.tsx`;
}

/**
 * Identity VirtualDocument for native TS/TSX/JS/JSX files where originalOffset === virtualOffset.
 */
export function createIdentityVirtualDocument(
  originalPath: string,
  content: string,
  sourceHash: string,
  framework: FrontendFrameworkId
): VirtualDocument {
  const len = content.length;
  const segments: VirtualSegment[] =
    len > 0
      ? [
          {
            originalStart: 0,
            originalEnd: len,
            virtualStart: 0,
            virtualEnd: len,
            kind: 'script',
          },
        ]
      : [];

  return {
    originalPath,
    virtualPath: originalPath,
    framework,
    isIdentity: true,
    virtualCode: content,
    sourceHash,
    segments,
    omissions: [],
    toVirtualOffset(originalOffset: number): number | null {
      if (originalOffset < 0 || originalOffset > len) return null;
      return originalOffset;
    },
    toOriginalSpan(virtualStart: number, virtualEnd: number = virtualStart): OriginalSpan | null {
      if (virtualStart < 0 || virtualStart > len) return null;
      const clampedEnd = Math.max(virtualStart, Math.min(virtualEnd, len));
      return { start: virtualStart, end: clampedEnd, kind: 'script' };
    },
  };
}

/**
 * Constructs a VirtualDocument with exact 1:1 character offset mapping for mapped segments
 * and O(log N) bidirectional lookup.
 */
export class VirtualDocumentBuilder {
  private readonly chunks: string[] = [];
  private readonly segments: VirtualSegment[] = [];
  private readonly omissions: ProjectionOmission[] = [];
  private virtualLength = 0;

  constructor(
    private readonly originalPath: string,
    private readonly rawContent: string,
    private readonly sourceHash: string,
    private readonly framework: FrontendFrameworkId
  ) {}

  appendSynthetic(code: string): this {
    if (!code) return this;
    this.chunks.push(code);
    this.virtualLength += code.length;
    return this;
  }

  /**
   * Copies rawContent.slice(originalStart, originalEnd) verbatim into virtualCode
   * and records an exact bidirectional offset segment.
   */
  appendMapped(originalStart: number, originalEnd: number, kind: VirtualSegmentKind): this {
    const start = Math.max(0, Math.min(originalStart, this.rawContent.length));
    const end = Math.max(start, Math.min(originalEnd, this.rawContent.length));
    if (end <= start) return this;

    const slice = this.rawContent.slice(start, end);
    const virtualStart = this.virtualLength;
    this.chunks.push(slice);
    this.virtualLength += slice.length;
    const virtualEnd = this.virtualLength;

    this.segments.push({
      originalStart: start,
      originalEnd: end,
      virtualStart,
      virtualEnd,
      kind,
    });
    return this;
  }

  /**
   * Maps a synthetic identifier/text (e.g. PascalCase tag name) back to an original span
   * even when the text lengths differ.
   */
  appendRenamed(
    virtualText: string,
    originalStart: number,
    originalEnd: number,
    kind: VirtualSegmentKind
  ): this {
    if (!virtualText) return this;
    const start = Math.max(0, Math.min(originalStart, this.rawContent.length));
    const end = Math.max(start, Math.min(originalEnd, this.rawContent.length));
    const virtualStart = this.virtualLength;
    this.chunks.push(virtualText);
    this.virtualLength += virtualText.length;
    const virtualEnd = this.virtualLength;

    this.segments.push({
      originalStart: start,
      originalEnd: end,
      virtualStart,
      virtualEnd,
      kind,
    });
    return this;
  }

  addOmission(omission: ProjectionOmission): this {
    this.omissions.push(omission);
    return this;
  }

  build(): VirtualDocument {
    const virtualCode = this.chunks.join('');
    // Segments are emitted in strictly ascending virtualStart order.
    const byVirtual = [...this.segments];
    // For original -> virtual lookup, sort by originalStart (preferring earliest virtual match).
    const byOriginal = [...this.segments].sort(
      (a, b) => a.originalStart - b.originalStart || a.virtualStart - b.virtualStart
    );
    const omissions = [...this.omissions];

    const toVirtualOffset = (originalOffset: number): number | null => {
      if (byOriginal.length === 0) return null;
      let lo = 0;
      let hi = byOriginal.length - 1;
      let candidate = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (byOriginal[mid].originalStart <= originalOffset) {
          candidate = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      // Scan backward over overlapping/adjacent segments starting <= originalOffset
      for (let i = candidate; i >= 0; i--) {
        const seg = byOriginal[i];
        if (originalOffset >= seg.originalStart && originalOffset <= seg.originalEnd) {
          const origLen = seg.originalEnd - seg.originalStart;
          const virtLen = seg.virtualEnd - seg.virtualStart;
          if (origLen === virtLen) {
            return seg.virtualStart + (originalOffset - seg.originalStart);
          }
          return seg.virtualStart;
        }
        if (seg.originalEnd < originalOffset && originalOffset - seg.originalEnd > 4096) {
          break;
        }
      }
      return null;
    };

    const toOriginalSpan = (
      virtualStart: number,
      virtualEnd: number = virtualStart
    ): OriginalSpan | null => {
      if (byVirtual.length === 0) return null;
      let lo = 0;
      let hi = byVirtual.length - 1;
      let idx = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (byVirtual[mid].virtualStart <= virtualStart) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (idx < 0) return null;
      const seg = byVirtual[idx];
      if (virtualStart > seg.virtualEnd) return null;

      const origLen = seg.originalEnd - seg.originalStart;
      const virtLen = seg.virtualEnd - seg.virtualStart;
      if (origLen !== virtLen) {
        return { start: seg.originalStart, end: seg.originalEnd, kind: seg.kind };
      }

      const mappedStart = seg.originalStart + (virtualStart - seg.virtualStart);
      const clampedVirtEnd = Math.max(virtualStart, Math.min(virtualEnd, seg.virtualEnd));
      const mappedEnd = seg.originalStart + (clampedVirtEnd - seg.virtualStart);
      return { start: mappedStart, end: mappedEnd, kind: seg.kind };
    };

    return {
      originalPath: this.originalPath,
      virtualPath: buildVirtualPath(this.originalPath, false),
      framework: this.framework,
      isIdentity: false,
      virtualCode,
      sourceHash: this.sourceHash,
      segments: byVirtual,
      omissions,
      toVirtualOffset,
      toOriginalSpan,
    };
  }
}
