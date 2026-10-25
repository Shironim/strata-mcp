#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';

const targets = [
  { target: 'bun-linux-x64', outfile: 'dist/strata-linux-x64' },
  { target: 'bun-linux-arm64', outfile: 'dist/strata-linux-arm64' },
  { target: 'bun-darwin-x64', outfile: 'dist/strata-darwin-x64' },
  { target: 'bun-darwin-arm64', outfile: 'dist/strata-darwin-arm64' },
  { target: 'bun-windows-x64', outfile: 'dist/strata-windows-x64.exe' },
] as const;

const requestedTarget = process.argv[2];
const targetsToBuild = requestedTarget
  ? targets.filter(t => t.target === requestedTarget || t.target === `bun-${requestedTarget}`)
  : targets;

if (targetsToBuild.length === 0) {
  console.error(`Unknown target: ${requestedTarget}`);
  process.exit(1);
}

mkdirSync('dist', { recursive: true });

const allowedVueDeps = new Set([
  '@babel/parser',
  'estree-walker',
  'magic-string',
  'postcss',
  'source-map-js',
  '@vue/compiler-core',
  '@vue/shared',
  '@vue/compiler-dom',
]);

const mockConsolidatePlugin = {
  name: 'mock-consolidate-engines',
  setup(build: any) {
    build.onResolve({ filter: /.*/ }, (args: any) => {
      if (args.importer?.includes('@vue/compiler-sfc')) {
        const isAllowed = allowedVueDeps.has(args.path) || args.path.startsWith('.') || args.path.startsWith('/');
        if (!isAllowed) {
          return { path: args.path, namespace: 'mock-engine' };
        }
      }
    });
    build.onLoad({ filter: /.*/, namespace: 'mock-engine' }, () => {
      return { contents: 'export default {};', loader: 'js' };
    });
  },
};

for (const { target, outfile } of targetsToBuild) {
  console.log(`Compiling ${target} -> ${outfile}...`);
  const result = await Bun.build({
    entrypoints: ['./bin/strata.ts'],
    target: 'bun',
    compile: {
      target: target as any,
      outfile,
    },
    plugins: [mockConsolidatePlugin],
  });

  if (!result.success) {
    console.error(`Failed to compile ${target}:`, result.logs);
    process.exit(1);
  }
}
console.log('Compilation completed successfully.');

