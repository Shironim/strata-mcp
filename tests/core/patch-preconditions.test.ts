import { describe, expect, it, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readSourceSnapshot } from '../../src/engine/source-file';
import {
  applyPatchesToSource,
  checkPatchPreconditions,
  validatePatchPreconditions,
} from '../../src/engine/patch-preconditions';
import type { ComponentPatchItem } from '../../src/types';

describe('Patch Preconditions & Validation (S6 / R-10)', () => {
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

      const output = applyPatchesToSource(source, patches);
      expect(output).toBe('<template><Child renamed="🙂" /><Child renamed="two" /></template>');

      await writeFile(file, output);
      await expect(validatePatchPreconditions(patches)).rejects.toThrow('STALE_SOURCE_REF');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports PATCH_FILE_NOT_FOUND for non-existent files', async () => {
    const patches: ComponentPatchItem[] = [{
      file: '/tmp/non-existent-strata-file-12345.vue',
      line: 1,
      column: 1,
      targetTag: 'Child',
      oldSnippet: 'old="1"',
      newSnippet: 'new="1"',
      description: 'rename',
      sourceRef: { sha256: 'abc', startOffset: 0, endOffset: 7 },
    }];

    const result = await checkPatchPreconditions(patches);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('PATCH_FILE_NOT_FOUND'))).toBe(true);
    await expect(validatePatchPreconditions(patches)).rejects.toThrow('PATCH_FILE_NOT_FOUND');
  });

  it('reports PATCH_INVALID_SPAN when startOffset is negative or greater than endOffset', async () => {
    const root = await mkdtemp('/tmp/strata-patch-span-');
    try {
      const file = join(root, 'Test.vue');
      await writeFile(file, '<template><div /></template>');
      const { snapshot } = await readSourceSnapshot(file);

      const invalidPatches: ComponentPatchItem[] = [{
        file,
        line: 1,
        column: 1,
        targetTag: 'div',
        oldSnippet: '<div />',
        newSnippet: '<span />',
        description: 'replace',
        sourceRef: { sha256: snapshot.sha256, startOffset: 15, endOffset: 5 }, // start > end
      }];

      const result = await checkPatchPreconditions(invalidPatches);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('PATCH_INVALID_SPAN'))).toBe(true);
      await expect(validatePatchPreconditions(invalidPatches)).rejects.toThrow('PATCH_INVALID_SPAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports PATCH_SNIPPET_MISMATCH when disk snippet differs from oldSnippet', async () => {
    const root = await mkdtemp('/tmp/strata-patch-mismatch-');
    try {
      const file = join(root, 'Test.vue');
      await writeFile(file, '<template><Child expected="value" /></template>');
      const { snapshot } = await readSourceSnapshot(file);

      const mismatchPatches: ComponentPatchItem[] = [{
        file,
        line: 1,
        column: 11,
        targetTag: 'Child',
        oldSnippet: 'unexpected="value"', // doesn't match content at offset
        newSnippet: 'new="value"',
        description: 'rename',
        sourceRef: { sha256: snapshot.sha256, startOffset: 16, endOffset: 32 },
      }];

      const result = await checkPatchPreconditions(mismatchPatches);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('PATCH_SNIPPET_MISMATCH'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('safely applies multiple non-overlapping patches in descending offset order preserving syntax', async () => {
    const source = `<template>
  <ProductCard
    title="Alpha"
    variant="primary"
    price="100"
  />
</template>`;

    const patches: ComponentPatchItem[] = [
      {
        file: 'Product.vue',
        line: 3,
        column: 5,
        targetTag: 'ProductCard',
        oldSnippet: 'title="Alpha"',
        newSnippet: 'heading="Alpha"',
        description: 'rename title to heading',
        sourceRef: { sha256: 'hash', startOffset: source.indexOf('title="Alpha"'), endOffset: source.indexOf('title="Alpha"') + 'title="Alpha"'.length },
      },
      {
        file: 'Product.vue',
        line: 4,
        column: 5,
        targetTag: 'ProductCard',
        oldSnippet: 'variant="primary"',
        newSnippet: 'theme="primary"',
        description: 'rename variant to theme',
        sourceRef: { sha256: 'hash', startOffset: source.indexOf('variant="primary"'), endOffset: source.indexOf('variant="primary"') + 'variant="primary"'.length },
      },
    ];

    const result = applyPatchesToSource(source, patches);
    expect(result).toContain('heading="Alpha"');
    expect(result).toContain('theme="primary"');
    expect(result).not.toContain('title="Alpha"');
    expect(result).not.toContain('variant="primary"');
  });
});
