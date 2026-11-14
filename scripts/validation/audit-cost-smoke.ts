import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { findUnusedComponents } from '../../src/engine/audit';

// Optional first argument: a separately captured baseline module with the same export.
const baselinePath = process.argv[2];
const implementations = [
  ...(baselinePath ? [{ label: 'baseline', analyze: (await import(pathToFileURL(resolve(baselinePath)).href)).findUnusedComponents as typeof findUnusedComponents }] : []),
  { label: 'current', analyze: findUnusedComponents },
];
const root = await mkdtemp(join(tmpdir(), 'strata-audit-cost-'));
try {
  const expected = Array.from({ length: 80 }, (_, i) => `Widget${i}`).sort();
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  for (let i = 0; i < 80; i++) await writeFile(join(root, `Widget${i}.vue`),
    `<script setup lang="ts">const count = ${i};</script><template><div>{{ count }}</div></template>`);
  const measurements = new Map<string, number[]>();
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const { label, analyze } of implementations) {
      const start = performance.now();
      const result = await analyze({ targetPath: root });
      const elapsed = Math.round(performance.now() - start);
      if (JSON.stringify(result.unusedComponents.map(item => item.name).sort()) !== JSON.stringify(expected)) {
        throw new Error(`${label}: expected precisely the 80 fixture component names`);
      }
      const times = measurements.get(label) ?? [];
      times.push(elapsed); measurements.set(label, times);
    }
  }
  console.log(JSON.stringify({ files: 80, expectedUnused: 80, bun: Bun.version, milliseconds: Object.fromEntries(measurements) }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
