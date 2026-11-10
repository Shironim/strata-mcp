import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { queryStateImpact } from '../../src/engine/storage/state-storage';
import { STRATA_VERSION } from '../../src/version';

test('React collection reads do not become write evidence; mutations and aliased actions still do', () => {
  const content = `import {useProductsStore} from './store';
const {items, setItems: apply} = useProductsStore();
const filtered = items.filter(p => p.active);
const page = items.slice(0, 10);
const computed = items['map'](p => p.name);
const optional = items?.slice(0);
items.push(product);
items.splice(0, 1);
items.sort();
items[0] = product;
items.length++;
apply([]);
function shadow(items: any) { items.push(product); }
items.forEach(p => { items[0] = p; });
`;
  const items = extractStateDependencies(content, 'react').items!;
  const writes = items.filter(item => item.accessMode === 'write');
  expect(writes.map(item => item.lineNumber)).toEqual([7, 8, 9, 10, 11, 12, 14]);
  for (const line of [3, 4, 5, 6]) {
    expect(items.some(item => item.lineNumber === line && item.accessMode === 'read')).toBe(true);
  }
});

test('React reader-only, writer-only and mixed consumers survive SQLite ingestion and role filters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-react-access-'));
  const header = `import {useProductsStore} from './store';\n`;
  try {
    await writeFile(join(root, 'Reader.tsx'), header + `export function Reader() {
const {items} = useProductsStore();
return <div>{items.filter(p => p.active).length}{items.slice(0, 5).length}</div>;
}`);
    await writeFile(join(root, 'Writer.tsx'), header + `export function Writer() {
const {setItems: apply} = useProductsStore();
return <button onClick={() => apply([])}>Clear</button>;
}`);
    await writeFile(join(root, 'Mixed.tsx'), header + `export function Mixed() {
const {items, setItems} = useProductsStore();
const filtered = items.filter(p => p.active);
setItems([]);
return <div>{items.slice(0, 5).length}</div>;
}`);
    getWorkspaceDatabase(root, { create: true, enableWatcher: false });
    await syncWorkspace(root);
    const all = await queryStateImpact(root, 'useProductsStore', 'all');
    expect(all.totalConsumers).toBe(3);
    expect(all.readersCount).toBe(1);
    expect(all.mutatorsCount).toBe(2);
    expect(all.readers?.[0].path).toEndWith('Reader.tsx');
    const mixed = all.mutators?.find(item => item.path.endsWith('Mixed.tsx'));
    expect(mixed?.actionsCalled).toEqual(['setItems([]);']);
    expect(mixed?.usageSnippet).toBe('setItems([]);');
    const readers = await queryStateImpact(root, 'useProductsStore', 'readers');
    expect(readers.consumers.map(item => item.path)).toEqual(all.readers!.map(item => item.path));
    const mutators = await queryStateImpact(root, 'useProductsStore', 'mutators');
    expect(mutators.consumers.map(item => item.path)).toEqual(all.mutators!.map(item => item.path));
    const db = getWorkspaceDatabase(root);
    db.run("UPDATE state_deps SET access_mode='write'");
    db.run("UPDATE meta SET value=? WHERE key='cache_version'", [`memory-v12:${STRATA_VERSION}`]);
    const refreshed = await queryStateImpact(root, 'useProductsStore', 'all');
    expect(refreshed.readersCount).toBe(1);
    expect(refreshed.mutatorsCount).toBe(2);
  } finally {
    closeWorkspaceDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
});
