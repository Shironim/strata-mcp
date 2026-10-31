import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readSourceSnapshot } from '../../src/engine/source-file';
import { validatePatchPreconditions } from '../../src/engine/patch-preconditions';
import type { ComponentPatchItem } from '../../src/types';

test('validates all patches on initial snapshot, applies descending offsets, rejects stale and overlapping plans', async () => {
  const root = await mkdtemp('/tmp/strata-patch-preconditions-');
  try {
    const file = join(root, 'Consumer.vue');
    const source = '<template><Child old="🙂" /><Child old="two" /></template>';
    await writeFile(file, source);
    const { snapshot } = await readSourceSnapshot(file);
    const patches: ComponentPatchItem[] = ['old="🙂"', 'old="two"'].map(oldSnippet => ({
      file, line: 1, column: source.indexOf(oldSnippet) + 1, targetTag: 'Child', oldSnippet,
      newSnippet: oldSnippet.replace('old=', 'renamed='), description: 'rename',
      sourceRef: { sha256: snapshot.sha256, startOffset: source.indexOf(oldSnippet), endOffset: source.indexOf(oldSnippet) + oldSnippet.length },
    }));
    await validatePatchPreconditions(patches);
    await expect(validatePatchPreconditions([patches[0], patches[0]])).rejects.toThrow('PATCH_SPAN_OVERLAP');
    await expect(validatePatchPreconditions([{ ...patches[0], sourceRef: undefined }])).rejects.toThrow('PATCH_PRECONDITION_MISSING');
    let output = source;
    for (const patch of [...patches].sort((a, b) => b.sourceRef!.startOffset - a.sourceRef!.startOffset)) {
      output = output.slice(0, patch.sourceRef!.startOffset) + patch.newSnippet + output.slice(patch.sourceRef!.endOffset);
    }
    expect(output).toBe('<template><Child renamed="🙂" /><Child renamed="two" /></template>');
    await writeFile(file, output);
    await expect(validatePatchPreconditions(patches)).rejects.toThrow('STALE_SOURCE_REF');
  } finally { await rm(root, { recursive: true, force: true }); }
});
