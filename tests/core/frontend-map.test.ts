import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFrontendMapAsText, mapFrontendScope } from '../../src/engine/frontend-map';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

test('maps stable bounded frontend inventory with candidate framework evidence and path hints', async () => {
  root = await mkdtemp(join(tmpdir(), 'strata-frontend-map-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3', nuxt: '^4' } }));
  await mkdir(join(root, 'components'));
  await mkdir(join(root, 'pages'));
  await writeFile(join(root, 'components', 'Card.vue'), '<template/>');
  await writeFile(join(root, 'pages', 'index.tsx'), 'export default function Page() { return null }');
  await writeFile(join(root, 'ignored.css'), 'body{}');
  await writeFile(join(root, 'ignored.ts'), 'export {};');
  await writeFile(join(root, '.gitignore'), 'ignored.ts\n');

  const first = await mapFrontendScope(root, { limit: 1, offset: 0 });
  expect(first.status).toBe('partial');
  expect(first.coverage.knownFiles).toBe(2);
  expect(first.files[0].path).toBe(join(root, 'components', 'Card.vue'));
  expect(first.files[0].roleHint).toBe('component');
  expect(first.files[0].roleHintEvidence.basis).toBe('heuristic');
  expect(first.frameworkCandidates.map(item => item.name)).toEqual(['vue', 'nuxt']);
  expect(first.frameworkCandidates[0].evidence.resolution).toBe('candidate');
  expect(first.unsupportedExtensions).toContain('.css');

  const second = await mapFrontendScope(root, { limit: 1, offset: 1 });
  expect(second.status).toBe('complete');
  expect(second.coverage.excludedDirs).toEqual([]);
  expect(second.files[0].path).toBe(join(root, 'pages', 'index.tsx'));

  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'build.ts'), 'console.log(1);');
  await mkdir(join(root, 'src', 'tools'), { recursive: true });
  await writeFile(join(root, 'src', 'tools', 'inspector.ts'), 'export const x = 1;');

  const withToolsAndSkipped = await mapFrontendScope(root, { limit: 100, offset: 0 });
  expect(withToolsAndSkipped.files.map(f => f.path)).toContain(join(root, 'src', 'tools', 'inspector.ts'));
  expect(withToolsAndSkipped.coverage.excludedDirs).toEqual([{ path: 'scripts', reason: 'default-ignore' }]);
  const text = formatFrontendMapAsText(withToolsAndSkipped);
  expect(text).toContain('Status: complete (excluding 1 directory)');
  expect(text).toContain('Excluded directories: scripts (default-ignore)');
});
