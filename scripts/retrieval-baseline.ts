import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { syncWorkspace } from '../src/engine/storage/delta-sync';
import { closeAllDatabases, getWorkspaceDatabase } from '../src/engine/storage/schema';
import { mapSourceFile } from '../src/engine/source-map';

// Engine-only ledger. This deliberately does not claim agent/MCP token savings.
const root = await mkdtemp('/tmp/strata-retrieval-measure-');
try {
  const source = '<script setup lang="ts">\nconst title = "café 🙂";\n</script>\n<template><h1>{{ title }}</h1></template>\n';
  await writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
  await writeFile(join(root, 'Page.vue'), source);
  getWorkspaceDatabase(root, { create: true, enableWatcher: false });
  const samples = [];
  for (let sample = 0; sample < 10; sample++) {
    const start = performance.now();
    const sync = await syncWorkspace(root);
    const syncMs = performance.now() - start;
    const request = { file: '<workspace>/Page.vue', maxRegions: 200 };
    const retrievalStart = performance.now();
    const map = await mapSourceFile(join(root, 'Page.vue'), { maxRegions: 200 });
    const retrievalMs = performance.now() - retrievalStart;
    const output = JSON.stringify(map).replaceAll(root, '<workspace>');
    samples.push({ sample, state: sample === 0 ? 'cold-index' : 'warm-index', syncMs, retrievalMs,
      parserInvocations: sync.parserInvocations, sourceBytes: Buffer.byteLength(source),
      requestBytes: Buffer.byteLength(JSON.stringify(request)), outputBytes: Buffer.byteLength(output) });
  }
  const artifact = {
    scope: 'engine sync + map only; normalized workspace path; no MCP transport or agent context measured',
    runtime: Bun.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    concurrency: 1, files: 1, samples,
    tokenMeasurement: 'NOT_MEASURED', correctnessOracle: 'tests/core/retrieval-baseline.test.ts',
  };
  const outputPath = process.argv[2];
  if (outputPath) await writeFile(resolve(outputPath), JSON.stringify(artifact, null, 2) + '\n');
  else console.log(JSON.stringify(artifact, null, 2));
} finally {
  closeAllDatabases();
  await rm(root, { recursive: true, force: true });
}
