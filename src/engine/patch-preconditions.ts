import type { ComponentPatchItem } from '../types';
import { readSourceSnapshot, sliceSourceSnapshot } from './source-file';

/** Validate every patch against the initial file snapshots before any mutation. No files are written. */
export async function validatePatchPreconditions(patches: ComponentPatchItem[]): Promise<void> {
  const snapshots = new Map<string, Awaited<ReturnType<typeof readSourceSnapshot>>>();
  for (const patch of patches) {
    if (!patch.sourceRef) throw new Error('PATCH_PRECONDITION_MISSING: regenerate the patch plan');
    let source = snapshots.get(patch.file);
    if (!source) {
      source = await readSourceSnapshot(patch.file);
      snapshots.set(patch.file, source);
    }
    if (sliceSourceSnapshot(source.snapshot, source.content, patch.sourceRef) !== patch.oldSnippet) {
      throw new Error('PATCH_SNIPPET_MISMATCH: regenerate the patch plan');
    }
  }
  for (const file of snapshots.keys()) {
    const ranges = patches.filter(p => p.file === file).map(p => p.sourceRef!).sort((a, b) => a.startOffset - b.startOffset);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].startOffset < ranges[i - 1].endOffset) throw new Error('PATCH_SPAN_OVERLAP: review conflicting patches');
    }
  }
}
