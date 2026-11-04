import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { discoverNuxtAutoImports } from '../../src/engine/nuxt-auto-imports';
import { inspectComponentTool } from '../../src/tools/inspect-component';

async function fixture(run: (root: string, write: (path: string, content: string) => Promise<void>) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'strata-nuxt-config-'));
  const write = async (path: string, content: string) => {
    await fs.mkdir(join(root, path, '..'), { recursive: true });
    await fs.writeFile(join(root, path), content);
  };
  try { await run(root, write); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('auto layers follow reverse alphabetical priority, explicit local ordering and deduplication', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', 'export default defineNuxtConfig({})');
  await write('layers/a/nuxt.config.ts', 'export default defineNuxtConfig({imports:{autoImport:true}})');
  await write('layers/z/nuxt.config.ts', 'export default defineNuxtConfig({imports:{autoImport:false}})');
  await write('layers/a/utils/a.ts', 'export function fromA(){}');
  expect((await discoverNuxtAutoImports(root)).enabled).toBe(false);
  await write('nuxt.config.ts', `export default defineNuxtConfig({extends:['~~/layers/a']})`);
  const result = await discoverNuxtAutoImports(root);
  expect(result.enabled).toBe(true);
  expect(result.configFiles).toHaveLength(3);
  expect(result.names.has('fromA')).toBe(true);
  expect(result.unresolved).toEqual([]);
}));

test('installed package config exports and subpath layers resolve without executing package code', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `export default defineNuxtConfig({extends:['@fixture/layer','plain-layer/sub']})`);
  await write('node_modules/@fixture/layer/package.json', '{"name":"@fixture/layer","type":"module","exports":{".":"./config.ts"}}');
  await write('node_modules/@fixture/layer/config.ts', `throw new Error('must never execute'); export default {imports:{scan:true}}`);
  await write('node_modules/@fixture/layer/utils/pkg.ts', 'export function packageHandler(){}');
  await write('node_modules/plain-layer/package.json', '{"name":"plain-layer"}');
  await write('node_modules/plain-layer/sub/nuxt.config.ts', 'export default {}');
  await write('node_modules/plain-layer/sub/utils/sub.ts', 'export function subHandler(){}');
  const result = await discoverNuxtAutoImports(root);
  expect([...result.names].sort()).toEqual(['packageHandler', 'subHandler']);
  expect(result.dependencies.some(dep => dep.path.endsWith('@fixture/layer/package.json'))).toBe(true);
  expect(result.configFiles.some(path => path.endsWith('config.ts'))).toBe(true);
}));

test('general imports globs select brace-extension files and nested directories', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `export default {imports:{dirs:['helpers/*/index.{ts,js}','other/*/**']}}`);
  await write('helpers/one/index.ts', 'export function first(){}');
  await write('helpers/two/index.js', 'export function second(){}');
  await write('helpers/one/ignored.ts', 'export function ignored(){}');
  await write('other/group/deep/run.ts', 'export function deep(){}');
  const result = await discoverNuxtAutoImports(root);
  expect([...result.names].sort()).toEqual(['deep', 'first', 'second']);
  expect(result.unresolved).toEqual([]);
}));

test('config local imports, const references, shorthand and known spreads preserve last-write semantics', () => fixture(async (root, write) => {
  await write('settings.ts', `export const directories = ['helpers']; export const options = {autoImport:false, scan:true};`);
  await write('nuxt.config.ts', `import {directories as dirs,options} from './settings'; const imports = {...options, autoImport:true, dirs:[...dirs]}; export default defineNuxtConfig({imports});`);
  await write('helpers/run.ts', 'export function configured(){}');
  const result = await discoverNuxtAutoImports(root);
  expect(result.enabled).toBe(true);
  expect(result.names.has('configured')).toBe(true);
  expect(result.unresolved).toEqual([]);
  const settings = result.dependencies.find(dep => dep.path === join(root, 'settings.ts'))!;
  expect(settings.hash).toBe(createHash('sha256').update(await fs.readFile(settings.path)).digest('hex'));
  await write('settings.ts', `export const directories = []; export const options = {autoImport:false, scan:true};`);
  expect((await discoverNuxtAutoImports(root)).names.has('configured')).toBe(false);
}));

test('unknown dynamic values invalidate earlier fields, while later explicit fields survive', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `const unknown = process.env.IMPORTS; export default {imports:{autoImport:false,...unknown}};`);
  let result = await discoverNuxtAutoImports(root);
  expect(result.unresolved.some(reason => reason.includes('dynamic imports'))).toBe(true);
  expect(result.enabled).toBe(true); // Unknown is not a proven disable.
  await write('nuxt.config.ts', `export default {imports:{...process.env.IMPORTS,autoImport:false}};`);
  result = await discoverNuxtAutoImports(root);
  expect(result.enabled).toBe(false);
  expect(result.unresolved.length).toBeGreaterThan(0);
  await write('base/nuxt.config.ts', 'export default {imports:{autoImport:false}}');
  await write('nuxt.config.ts', `export default {extends:['./base'],imports:{autoImport:process.env.AUTO_IMPORT}};`);
  result = await discoverNuxtAutoImports(root);
  expect(result.enabled).toBe(true); // A dynamic higher-priority value blocks inherited certainty.
  expect(result.unresolved.some(reason => reason.includes('dynamic imports.autoImport'))).toBe(true);
  await write('nuxt.config.ts', `const config={imports:{autoImport:false}}; const mutation=change(config); export default config;`);
  expect((await discoverNuxtAutoImports(root)).unresolved.some(reason => reason.includes('dynamic config'))).toBe(true);
  await write('nuxt.config.ts', `import {evil as defineNuxtConfig} from './unknown'; export default defineNuxtConfig({imports:{autoImport:false}});`);
  expect((await discoverNuxtAutoImports(root)).unresolved.some(reason => reason.includes('dynamic config'))).toBe(true);
}));

test('export-star closure excludes type-only names and binds source dependencies through inspect', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', 'export default {}');
  await write('composables/index.ts', `export * from '../logic'; export type {Hidden} from '../types'; export {default as aliased} from '../default';`);
  await write('logic.ts', `export function actual(){}; export interface Shape{}; export {Shape};`);
  await write('types.ts', 'export interface Hidden{}');
  await write('default.ts', 'export default function implementation(){}');
  await write('Home.vue', '<template><button @click="actual"/></template>');
  const result = await discoverNuxtAutoImports(root);
  expect([...result.names].sort()).toEqual(['actual', 'aliased']);
  expect(result.dependencies.some(dep => dep.path === join(root, 'logic.ts'))).toBe(true);
  expect(result.dependencies.some(dep => dep.path === join(root, 'types.ts'))).toBe(false);
  const response = await inspectComponentTool.handler({path:join(root,'Home.vue'),project_root:root,audit_events:true,resolve_globals:false,format:'json'});
  expect(response.isError).not.toBe(true);
  const structured = response.structuredContent as any;
  expect(structured.eventAudit.autoImportDependencies.some((dep: any) => dep.path === join(root,'logic.ts'))).toBe(true);
  expect(structured.dependencies.some((dep: any) => dep.path === join(root,'logic.ts'))).toBe(true);
}));

test('remote, missing package and function config retain unresolved evidence', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `export default {extends:['github:fixture/layer#v1','missing-package']}`);
  let result = await discoverNuxtAutoImports(root);
  expect(result.unresolved.some(reason => reason.includes('remote layer'))).toBe(true);
  expect(result.unresolved.some(reason => reason.includes('missing installed package'))).toBe(true);
  await write('nuxt.config.ts', 'export default () => ({imports:{autoImport:false}})');
  result = await discoverNuxtAutoImports(root);
  expect(result.unresolved.some(reason => reason.includes('dynamic config'))).toBe(true);
}));

test('literal JSON config and re-exported config constants are read as data', () => fixture(async (root, write) => {
  await write('nuxt.config.json', '{"imports":{"autoImport":false}}');
  expect((await discoverNuxtAutoImports(root)).enabled).toBe(false);
  await write('options.ts', 'export const config = {imports:{scan:false}};');
  await write('bridge.ts', `export {config as default} from './options';`);
  await write('nuxt.config.ts', `export {default} from './bridge';`);
  const result = await discoverNuxtAutoImports(root);
  expect(result.names.size).toBe(0);
  expect(result.unresolved).toEqual([]);
  expect(result.dependencies.some(dep => dep.path.endsWith('options.ts'))).toBe(true);
}));

test('cyclic config/export bindings are partial and do not recurse indefinitely', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `import config from './loop'; export default config;`);
  await write('loop.ts', `export {default} from './nuxt.config';`);
  await write('composables/index.ts', `export * from '../cycle'; export function retained(){}`);
  await write('cycle.ts', `export * from './composables/index'; export interface Hidden {}`);
  const result = await discoverNuxtAutoImports(root);
  expect(result.unresolved.some(reason => reason.includes('cyclic config'))).toBe(true);
  expect(result.unresolved.some(reason => reason.includes('cyclic export'))).toBe(true);
  expect(result.names.has('retained')).toBe(true);
  expect(result.names.has('Hidden')).toBe(false);
}));

test('distinct config subpath exports in one package are not deduplicated as one layer', () => fixture(async (root, write) => {
  await write('nuxt.config.ts', `export default {extends:['multi/first','multi/second'],imports:{dirs:['root-helpers']}}`);
  await write('node_modules/multi/package.json', '{"name":"multi","exports":{"./first":"./first.ts","./second":"./second.ts"}}');
  await write('node_modules/multi/first.ts', `export default {imports:{dirs:['a']}}`);
  await write('node_modules/multi/second.ts', `export default {imports:{dirs:['b']}}`);
  await write('node_modules/multi/a/a.ts', 'export function first(){}');
  await write('node_modules/multi/b/b.ts', 'export function second(){}');
  await write('root-helpers/root.ts', 'export function rootHandler(){}');
  const result = await discoverNuxtAutoImports(root);
  expect([...result.names].sort()).toEqual(['first', 'rootHandler', 'second']);
  expect(result.configFiles).toHaveLength(3);
}));
