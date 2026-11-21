import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analysisBuildDefines } from '../src/analysis-source-fingerprint';

const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist' } } });
const root = resolve(import.meta.dir, '..');
const result = await Bun.build({
  entrypoints: ['cli', 'mcp', 'index'].map(name => resolve(root, 'src', name + '.ts')),
  outdir: resolve(values.outdir!),
  target: 'bun',
  external: ['@vue/compiler-sfc', '@vue/compiler-dom', '@modelcontextprotocol/sdk'],
  define: analysisBuildDefines(root),
});
for (const file of result.outputs) console.log(file.path);
