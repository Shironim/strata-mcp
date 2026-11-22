import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildExplorerHtml } from './build-explorer';
import { analysisBuildDefines } from '../src/analysis-source-fingerprint';

const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist' } } });
const root = resolve(import.meta.dir, '..');
const outdir = resolve(values.outdir!);

const result = await Bun.build({
  entrypoints: [
    ...['cli', 'index'].map(name => resolve(root, 'src', name + '.ts')),
    resolve(root, 'src', 'engine', 'v2', 'parse-worker.ts'),
  ],
  outdir,
  target: 'bun',
  external: ['@vue/compiler-sfc', '@vue/compiler-dom', '@modelcontextprotocol/sdk'],
  define: analysisBuildDefines(root),
});
for (const file of result.outputs) console.log(file.path);

const uiOutPath = resolve(outdir, 'ui', 'explorer.html');
mkdirSync(dirname(uiOutPath), { recursive: true });
writeFileSync(uiOutPath, await buildExplorerHtml(root), 'utf8');
console.log(uiOutPath);
