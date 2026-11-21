import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

// Follow the production imports that can affect published index data.
const INDEX_ENTRY = 'src/engine/storage/delta-sync.ts';
const IDENTITY_MODULE = 'src/version.ts';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

function resolveLocalImport(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map(ext => base + ext),
    ...SOURCE_EXTENSIONS.map(ext => resolve(base, 'index' + ext)),
  ];
  const resolved = candidates.find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!resolved) throw new Error(`Unable to resolve analysis input ${specifier} from ${file}`);
  return resolved;
}

export function computeAnalysisSourceFingerprint(root: string): string {
  const scan = new Bun.Transpiler({ loader: 'tsx' });
  const pending = [resolve(root, INDEX_ENTRY)];
  const hashes = new Map<string, string>();
  for (const file of pending) {
    const key = relative(root, file).split(sep).join('/');
    // Package version and build identity are inputs to response metadata only.
    if (key === IDENTITY_MODULE || key === 'package.json' || hashes.has(key)) continue;
    if (key.startsWith('../')) throw new Error(`Analysis input is outside the source root: ${key}`);
    const bytes = readFileSync(file);
    hashes.set(key, createHash('sha256').update(bytes).digest('hex'));
    if (extname(file) === '.json') continue;
    for (const { path } of scan.scanImports(bytes.toString('utf8'))) {
      if (path.startsWith('./') || path.startsWith('../')) pending.push(resolveLocalImport(file, path));
    }
  }
  const entries = [...hashes.keys()].sort().map(path => [path, hashes.get(path)]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function analysisBuildDefines(root: string): Record<string, string> {
  return { __STRATA_ANALYSIS_SOURCE__: JSON.stringify(computeAnalysisSourceFingerprint(root)) };
}
