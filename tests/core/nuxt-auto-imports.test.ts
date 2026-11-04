import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverNuxtAutoImports } from '../../src/engine/nuxt-auto-imports';
import { auditEventHandlers, formatEventHandlerAuditAsText } from '../../src/engine/reactivity';
import { inspectComponentTool } from '../../src/tools/inspect-component';

test('Nuxt candidates follow exported names, config switches and fresh source', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-auto-imports-'));
  try {
    await fs.mkdir(join(root, 'composables', 'nested'), { recursive: true });
    await fs.writeFile(join(root, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
    await fs.writeFile(join(root, 'composables', 'helpers.ts'), `
      const privateHandler = () => {};
      export function saveItem() {}
      export { privateHandler as renamedHandler };
      export type { Thing } from './types';
      export interface HiddenType {}
    `);
    await fs.writeFile(join(root, 'composables', 'nested', 'ignored.ts'), 'export function nestedHandler() {}');
    await fs.writeFile(join(root, 'Home.vue'), `<template><button @click="saveItem"/><button @click="useTypo"/><button @click="navigateTo"/></template>`);
    const discovered = await discoverNuxtAutoImports(root);
    expect([...discovered.names].sort()).toEqual(['renamedHandler', 'saveItem']);
    const audit = await auditEventHandlers({ path: join(root, 'Home.vue') });
    expect(audit.candidateHandlers?.map(item => item.handlerName)).toEqual(['saveItem', 'navigateTo']);
    expect(audit.brokenHandlers.map(item => item.handlerName)).toEqual(['useTypo']);
    await fs.writeFile(join(root, 'nuxt.config.ts'), 'export default defineNuxtConfig({ imports: { autoImport: false } } as const)');
    const disabled = await auditEventHandlers({ path: join(root, 'Home.vue') });
    expect(disabled.candidateHandlers ?? []).toHaveLength(0);
    expect(disabled.brokenHandlers).toHaveLength(3);
    await fs.writeFile(join(root, 'nuxt.config.ts'), 'export default defineNuxtConfig({ imports: { scan: false } })');
    const noScan = await discoverNuxtAutoImports(root);
    expect(noScan.enabled).toBe(true);
    expect(noScan.names.size).toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Vue pages and use-prefixed names alone do not establish Nuxt auto-imports', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-vue-auto-imports-'));
  try {
    await fs.mkdir(join(root, 'pages'));
    await fs.writeFile(join(root, 'package.json'), '{"dependencies":{"vue":"3"}}');
    const path = join(root, 'pages', 'Home.vue');
    await fs.writeFile(path, '<template><button @click="useTypo"/><button @click="navigateTo"/></template>');
    const audit = await auditEventHandlers({ path });
    expect(audit.candidateHandlers ?? []).toHaveLength(0);
    expect(audit.brokenHandlers).toHaveLength(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('literal srcDir, default exports and overrides preserve bounded discovery', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-srcdir-'));
  try {
    await fs.mkdir(join(root, 'src', 'utils'), { recursive: true });
    const config = join(root, 'nuxt.config.ts');
    await fs.writeFile(config, `export default defineNuxtConfig(({ srcDir: 'src', imports: { autoImport: false, autoImport: true } }) satisfies object)`);
    const helper = join(root, 'src', 'utils', 'save.ts');
    await fs.writeFile(helper, `export default function internalName() {}; export declare function ambient(): void; export const active = () => {};`);
    expect([...(await discoverNuxtAutoImports(root)).names].sort()).toEqual(['active', 'save']);
    await fs.writeFile(helper, 'export const replacement = () => {}');
    expect([...(await discoverNuxtAutoImports(root)).names]).toEqual(['replacement']);
    await fs.writeFile(config, `export default defineNuxtConfig({ srcDir: 'src', imports: { ...dynamic, ['autoImport']: false } })`);
    expect((await discoverNuxtAutoImports(root)).enabled).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local layers, custom recursive dirs and root switches reach handler audits', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-layers-'));
  try {
    const base = join(root, 'base');
    await fs.mkdir(join(base, 'src', 'utils'), { recursive: true });
    await fs.mkdir(join(root, 'src', 'custom', 'nested'), { recursive: true });
    await fs.writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({ srcDir: 'src', extends: ['./base'], imports: { autoImport: true, scan: true, dirs: ['~/custom/**'] } })`);
    await fs.writeFile(join(base, 'nuxt.config.ts'), `export default defineNuxtConfig({ srcDir: 'src', imports: { autoImport: false } })`);
    await fs.writeFile(join(base, 'src', 'utils', 'save.ts'), 'export function baseSave() {}');
    await fs.writeFile(join(root, 'src', 'custom', 'nested', 'load.ts'), 'export function customLoad() {}');
    const discovery = await discoverNuxtAutoImports(root);
    expect([...discovery.names].sort()).toEqual(['baseSave', 'customLoad']);
    expect(discovery.configFiles).toHaveLength(2);
    expect(discovery.unresolved).toEqual([]);
    const path = join(root, 'Home.vue');
    await fs.writeFile(path, '<template><button @click="baseSave"/><button @click="customLoad"/></template>');
    expect((await auditEventHandlers({ path })).candidateHandlers).toHaveLength(2);
    await fs.writeFile(join(base, 'nuxt.config.ts'), `export default defineNuxtConfig({ srcDir: 'src', imports: { scan: false } })`);
    expect([...(await discoverNuxtAutoImports(root)).names]).toEqual(['customLoad']);
    await fs.writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: ['./base'] })`);
    expect((await discoverNuxtAutoImports(root)).names.size).toBe(0);
    await fs.writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: ['./base'], imports: { autoImport: false } })`);
    expect((await discoverNuxtAutoImports(root)).enabled).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('nested extends uses declaring layer paths and reports unsupported or cyclic input', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-closure-'));
  try {
    await fs.mkdir(join(root, 'a', 'b', 'composables'), { recursive: true });
    await fs.writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: ['./a', 'github:org/layer', './missing'], imports: { dirs: ['helpers/*/index.ts', dynamicDir] } })`);
    await fs.writeFile(join(root, 'a', 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: ['./b'] })`);
    await fs.writeFile(join(root, 'a', 'b', 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: ['../..'] })`);
    await fs.writeFile(join(root, 'a', 'b', 'composables', 'deep.ts'), 'export function deepHandler() {}');
    const result = await discoverNuxtAutoImports(root);
    expect([...result.names]).toEqual(['deepHandler']);
    expect(result.configFiles).toHaveLength(3);
    expect(result.unresolved.some(reason => reason.includes('cyclic extends'))).toBe(true);
    expect(result.unresolved.some(reason => reason.includes('unsupported layer'))).toBe(true);
    expect(result.unresolved.some(reason => reason.includes('missing layer'))).toBe(true);
    expect(result.unresolved.some(reason => reason.includes('unsupported imports.dirs pattern'))).toBe(false);
    expect(result.unresolved.some(reason => reason.includes('dynamic imports.dirs'))).toBe(true);
    const path = join(root, 'Home.vue');
    await fs.writeFile(path, '<template><button @click="deepHandler"/><button @click="unknown"/></template>');
    const audit = await auditEventHandlers({ path });
    expect(audit.autoImportUnresolved).toEqual(result.unresolved);
    expect(formatEventHandlerAuditAsText(audit)).toContain('discovery is partial');
    for (const response_detail of ['full', 'summary']) {
      const response = await inspectComponentTool.handler({ path, project_root: root, audit_events: true, resolve_globals: false, format: 'json', response_detail });
      expect(response.isError).not.toBe(true);
      const structured = response.structuredContent as any;
      expect(structured.retrieval.omissions.some((item: any) => item.code === 'NUXT_AUTO_IMPORT_PARTIAL')).toBe(true);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
