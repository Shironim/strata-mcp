import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { parseContractExpectation, verifyContractExpectation } from '../../src/engine/contract-expectation';
import type { ComponentContract } from '../../src/types';

test('contract expectations reject ignored, duplicate and contradictory checks', () => {
  for (const value of [null, {}, { props: [] }, { props: [{ name: 'x', exists: false, type: 'string' }] },
    { props: [{ name: 'x', exists: true }, { name: 'x', exists: false }] }, { props: [{ name: 'x', exists: true, ignored: true }] },
    { props: [{ name: 'x', exists: true }], events: [] }]) expect(() => parseContractExpectation(value)).toThrow('INVALID_CONTRACT_EXPECTATION');
});

test('closed-declaration gate does not certify absence when extraction missed a prop or macro binding is shadowed', () => {
  const contract = { filePath: '/fixture/Child.vue', props: [] } as unknown as ComponentContract;
  const expectation = { props: [{ name: 'hidden', exists: false }] };
  for (const script of ['defineProps<{ hidden: string }>()', 'const defineProps = factory; defineProps<{}>()', 'const build = () => defineProps<{}>()']) {
    const result = verifyContractExpectation({ contract, expectation, sourceCurrent: true,
      content: `<script setup lang="ts">${script}</script><template><div/></template>` });
    expect(result.status).toBe('UNKNOWN');
  }
});

test('before/after rename expectations pass or fail independently from successful parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-contract-expect-'));
  try {
    const file = join(root, 'Child.vue');
    await writeFile(file, '<script setup lang="ts">defineProps<{ label: string }>()</script><template><div /></template>');
    const args = { path: file, project_root: root, resolve_globals: false, format: 'json' };
    const before = await inspectComponentTool.handler(args);
    const expectation = { props: [{ name: 'label', exists: false }, { name: 'heading', exists: true, type: 'string', required: true }] };
    const wrong = await inspectComponentTool.handler({ ...args, expectation });
    expect(wrong.isError).not.toBe(true);
    expect((wrong.structuredContent?.verification as any).status).toBe('FAIL');
    await writeFile(file, '<script setup lang="ts">defineProps<{ heading: string }>()</script><template><div /></template>');
    const after = await inspectComponentTool.handler({ ...args, expectation, impact: 'summary' });
    expect(after.isError).not.toBe(true);
    expect((after.structuredContent?.verification as any).status).toBe('PASS');
    expect((after.structuredContent?.retrieval as any).source.sha256).not.toBe((before.structuredContent?.retrieval as any).source.sha256);
    expect((after.structuredContent?.decision as any).status).toBe('partial');
    expect(JSON.parse(after.content[0]!.text).verification).toEqual(after.structuredContent?.verification);
    const incompatible = await inspectComponentTool.handler({ ...args, expectation: { props: [{ name: 'heading', exists: true, type: 'number' }] } });
    expect((incompatible.structuredContent?.verification as any).status).toBe('FAIL');
    const text = await inspectComponentTool.handler({ ...args, expectation, format: 'text' });
    expect(text.content[0]!.text).toContain('Contract verification:');
    await writeFile(join(root, 'types.ts'), 'export interface Props { heading: string }');
    await writeFile(file, '<script setup lang="ts">import type { Props } from "./types";defineProps<Props>()</script><template><div /></template>');
    const imported = await inspectComponentTool.handler({ ...args, expectation });
    expect((imported.structuredContent?.verification as any).status).toBe('UNKNOWN');
    await writeFile(file, '<script setup>defineProps({ ...externalProps })</script><template><div /></template>');
    const dynamic = await inspectComponentTool.handler({ ...args, expectation });
    expect((dynamic.structuredContent?.verification as any).status).toBe('UNKNOWN');
    expect((await inspectComponentTool.handler({ ...args, view: 'map', expectation })).isError).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
