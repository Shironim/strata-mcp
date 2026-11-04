import type { ComponentPatchItem } from '../types';
import { readSourceSnapshot, sliceSourceSnapshot } from './source-file';

export interface PreconditionValidationResult {
  valid: boolean;
  validatedPatchCount: number;
  errors: string[];
}

/**
 * Checks all patch preconditions non-destructively, returning structured diagnostics.
 */
export async function checkPatchPreconditions(patches: ComponentPatchItem[]): Promise<PreconditionValidationResult> {
  const errors: string[] = [];
  const snapshots = new Map<string, Awaited<ReturnType<typeof readSourceSnapshot>>>();

  for (const patch of patches) {
    if (!patch.sourceRef) {
      errors.push(`PATCH_PRECONDITION_MISSING: patch for "${patch.file}" is missing sourceRef precondition`);
      continue;
    }

    if (
      patch.sourceRef.startOffset < 0 ||
      patch.sourceRef.endOffset < patch.sourceRef.startOffset
    ) {
      errors.push(`PATCH_INVALID_SPAN: patch for "${patch.file}" has invalid offsets [${patch.sourceRef.startOffset}, ${patch.sourceRef.endOffset}]`);
      continue;
    }

    let source = snapshots.get(patch.file);
    if (!source) {
      try {
        source = await readSourceSnapshot(patch.file);
        snapshots.set(patch.file, source);
      } catch {
        errors.push(`PATCH_FILE_NOT_FOUND: target file "${patch.file}" could not be read`);
        continue;
      }
    }

    if (source.snapshot.sha256 !== patch.sourceRef.sha256) {
      errors.push(`STALE_SOURCE_REF: file "${patch.file}" content hash changed on disk (expected ${patch.sourceRef.sha256}, got ${source.snapshot.sha256})`);
      continue;
    }

    if (typeof patch.line === 'number' && typeof patch.column === 'number') {
      const lines = source.content.split('\n');
      if (patch.line < 1 || patch.line > lines.length || patch.column < 1) {
        errors.push(`PATCH_COORDINATE_MISMATCH: patch for "${patch.file}" has out-of-bounds coordinates (${patch.line}:${patch.column})`);
      } else {
        const expectedOffset = lines.slice(0, patch.line - 1).reduce((sum, l) => sum + l.length + 1, 0) + patch.column - 1;
        if (expectedOffset !== patch.sourceRef.startOffset) {
          errors.push(`PATCH_COORDINATE_MISMATCH: patch line/column (${patch.line}:${patch.column}) offset ${expectedOffset} does not match startOffset ${patch.sourceRef.startOffset} in "${patch.file}"`);
        }
      }
    }

    if (patch.sourceRef.endOffset !== patch.sourceRef.startOffset + patch.oldSnippet.length) {
      errors.push(`PATCH_INVALID_SPAN: patch for "${patch.file}" endOffset (${patch.sourceRef.endOffset}) does not match startOffset + oldSnippet length (${patch.sourceRef.startOffset + patch.oldSnippet.length})`);
    }

    try {
      const actualSnippet = sliceSourceSnapshot(source.snapshot, source.content, patch.sourceRef);
      if (actualSnippet !== patch.oldSnippet) {
        errors.push(`PATCH_SNIPPET_MISMATCH: snippet at [${patch.sourceRef.startOffset}:${patch.sourceRef.endOffset}] in "${patch.file}" does not match oldSnippet`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
    }
  }

  for (const file of snapshots.keys()) {
    const filePatches = patches.filter(p => p.file === file && p.sourceRef && p.sourceRef.startOffset >= 0);
    const ranges = filePatches.map(p => p.sourceRef!).sort((a, b) => a.startOffset - b.startOffset);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].startOffset < ranges[i - 1].endOffset) {
        errors.push(`PATCH_SPAN_OVERLAP: conflicting overlapping patch spans detected in "${file}" at offsets [${ranges[i - 1].startOffset}:${ranges[i - 1].endOffset}] and [${ranges[i].startOffset}:${ranges[i].endOffset}]`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    validatedPatchCount: errors.length === 0 ? patches.length : 0,
    errors,
  };
}

/** Validate every patch against the initial file snapshots before any mutation. No files are written. */
export async function validatePatchPreconditions(patches: ComponentPatchItem[]): Promise<void> {
  const result = await checkPatchPreconditions(patches);
  if (!result.valid && result.errors.length > 0) {
    throw new Error(result.errors[0]);
  }
}

/**
 * Applies a list of validated non-overlapping patches to source content in descending offset order.
 * Applying in descending order preserves offsets of earlier patches.
 */
export function applyPatchesToSource(originalContent: string, patchesForFile: ComponentPatchItem[]): string {
  const sorted = [...patchesForFile].sort((a, b) => {
    const aStart = a.sourceRef?.startOffset ?? 0;
    const bStart = b.sourceRef?.startOffset ?? 0;
    return bStart - aStart;
  });

  let result = originalContent;
  for (const patch of sorted) {
    if (!patch.sourceRef) continue;
    const { startOffset, endOffset } = patch.sourceRef;
    result = result.slice(0, startOffset) + patch.newSnippet + result.slice(endOffset);
  }
  return result;
}
