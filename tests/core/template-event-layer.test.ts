import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRenderBoundary } from '../../src/engine/contract';
import { extractAstroContract } from '../../src/engine/parsers/contract-astro';
import { auditEventHandlers } from '../../src/engine/reactivity';
import { astroOpeningTags } from '../../src/engine/astro-template';
import type { FrontendFramework } from '../../src/types';

for (const framework of ['vue', 'nuxt'] as const) {
}

for (const framework of ['react', 'next'] as const) {
}

test('Astro: one hydrated sibling does not hide unhydrated widget candidates', () => {
  const result = extractRenderBoundary('/Card.astro','<Counter client:load/><SaveButton/>','astro');
  expect(result.isClientHydrated).toBe(true);
  expect(result.violations?.[0].message).toContain('SaveButton');
});

test('Astro: opening tag scan retains nested values and tags in conditional expressions', () => {
  const template = `{ready && <Card value={{key: '}', nested: {value: 1}}} client:load />}
    <Card value={\`hello \${other({key:'}'})}\`} client:idle/>`;
  expect(astroOpeningTags(template).map(item=>item.name)).toEqual(['Card','Card']);
});
