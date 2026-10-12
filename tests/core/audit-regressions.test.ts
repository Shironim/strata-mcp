import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { initSchema } from '../../src/engine/storage/schema';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/storage/schema';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { WorkspaceWatcher } from '../../src/engine/watcher';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { collectFiles } from '../../src/engine/collector';
import { extractApiContractsFromCode } from '../../src/engine/api-contract';

const roots: string[] = [];
const watchers: WorkspaceWatcher[] = [];
function workspace() {
  const root = mkdtempSync('/tmp/strata-regression-');
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"react":"1"}}');
  return root;
}
function put(root: string, file: string, content: string) {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), content);
}
afterEach(() => {
  watchers.splice(0).forEach(w => w.close());
  closeAllDatabases();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('Audit regression cases', () => {
  it('watcher updates the database supplied by its caller', async () => {
    const root = workspace();
    put(root, 'App.tsx', 'export default () => <div />;');
    const db = new Database(':memory:');
    initSchema(db);
    const watcher = new WorkspaceWatcher(root, db, { debounceMs: 60_000 });
    watchers.push(watcher);
    try {
      (watcher as any).handleFsEvent('App.tsx');
      await watcher.flushQueue();
      expect(db.query('SELECT path FROM files').all()).toEqual([{ path: join(root, 'App.tsx') }]);
    } finally {
      watcher.close();
      db.close();
    }
  });

  it('watcher updates and deletes the same canonical file rows as full sync', async () => {
    const root = workspace();
    put(root, 'App.tsx', 'export default () => <div />;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    const watcher = new WorkspaceWatcher(root, db, { debounceMs: 60_000 });
    watchers.push(watcher);
    put(root, 'App.tsx', 'export default () => <main />;');
    (watcher as any).handleFsEvent('App.tsx');
    await watcher.flushQueue();
    expect(db.query('SELECT path FROM files').all()).toEqual([{ path: join(root, 'App.tsx') }]);
    unlinkSync(join(root, 'App.tsx'));
    (watcher as any).handleFsEvent('App.tsx');
    await watcher.flushQueue();
    expect(db.query('SELECT path FROM files').all()).toEqual([]);
  });

  it('scoped sync preserves sibling directories with the same prefix', async () => {
    const root = workspace();
    put(root, 'src/a.ts', 'export const a = 1;');
    put(root, 'src-extra/b.ts', 'export const b = 1;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    await syncWorkspace(root, 'src');
    expect(db.query('SELECT path FROM files ORDER BY path').all()).toHaveLength(2);
  });

  it('full sync resolves aliases and explicit extensions in graph edges', async () => {
    const root = workspace();
    put(root, 'tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
    put(root, 'src/Button.tsx', 'export default () => <button />;');
    put(root, 'src/App.tsx', 'import Button from "@/Button.tsx";\nexport default () => <Button />;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    expect(db.query('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 });
  });

  for (const [name, markup, count] of [
    ['same-line sibling', '<><Button title="x" /><Other title="y" /></>', 1],
    ['multiline attribute', '<Button\n title="x"\n />', 1],
    ['import alias', '<Alias title="x" />', 1],
  ] as const) {
    it(`JSX patch plan handles ${name}`, async () => {
      const root = workspace();
      put(root, 'Button.tsx', 'export default () => <button />;');
      put(root, 'App.tsx', `import ${name === 'import alias' ? 'Alias' : 'Button'} from "./Button";\nexport default () => ${markup};`);
      const result = await generatePatchPlan({ componentPath: join(root, 'Button.tsx'), refactorType: 'rename_prop', oldName: 'title', newName: 'label' });
      expect(result.totalPatches).toBe(count);
      const source = Bun.file(join(root, 'App.tsx'));
      const lines = (await source.text()).split('\n');
      for (const patch of result.patches) {
        expect(lines[patch.line - 1].slice(patch.column - 1, patch.column - 1 + patch.oldSnippet.length)).toBe('title');
      }
    });
  }

  it('JSX removal captures an entire nested attribute expression', async () => {
    const root = workspace();
    put(root, 'Button.tsx', 'export default () => <button />;');
    put(root, 'App.tsx', 'import Button from "./Button";\nexport default () => <Button title={{ text: "x" }} />;');
    const result = await generatePatchPlan({ componentPath: join(root, 'Button.tsx'), refactorType: 'remove_prop', oldName: 'title' });
    expect(result.patches.map(p => p.oldSnippet)).toEqual(['title={{ text: "x" }}']);
  });

  it('JSX patches do not use the target basename when it is bound to another import', async () => {
    const root = workspace();
    put(root, 'Button.tsx', 'export default () => <button />;');
    put(root, 'Other.tsx', 'export default () => <div />;');
    put(root, 'App.tsx', 'import Alias from "./Button";\nimport Button from "./Other";\nexport default () => <><Alias title="x" /><Button title="y" /></>;');
    const result = await generatePatchPlan({ componentPath: join(root, 'Button.tsx'), refactorType: 'rename_prop', oldName: 'title', newName: 'label' });
    expect(result.patches.map(p => p.targetTag)).toEqual(['Alias']);
  });

  it('scoped sync keeps workspace ignore rules in effect', async () => {
    const root = workspace();
    put(root, '.gitignore', 'src/Hidden.ts\n');
    put(root, 'src/Hidden.ts', 'export const hidden = 1;');
    put(root, 'src/Visible.ts', 'export const visible = 1;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    await syncWorkspace(root, 'src');
    expect(db.query('SELECT path FROM files').all()).toEqual([{ path: join(root, 'src/Visible.ts') }]);
  });

  it('scoped sync inherits workspace ignore rules across nested package roots', async () => {
    const root = workspace();
    put(root, '.gitignore', 'packages/app/src/Hidden.ts\n');
    put(root, 'packages/app/package.json', '{}');
    put(root, 'packages/app/src/Hidden.ts', 'export const hidden = 1;');
    put(root, 'packages/app/src/Visible.ts', 'export const visible = 1;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    await syncWorkspace(root, 'packages/app/src');
    expect(db.query('SELECT path FROM files').all()).toEqual([{ path: join(root, 'packages/app/src/Visible.ts') }]);
  });

  it('sync drops edges to files newly excluded by ignore rules', async () => {
    const root = workspace();
    put(root, 'Button.tsx', 'export default () => <button />;');
    put(root, 'App.tsx', 'import Button from "./Button";\nexport default () => <Button />;');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    await syncWorkspace(root);
    put(root, '.gitignore', 'Button.tsx\n');
    put(root, 'App.tsx', 'import Button from "./Button";\nexport default () => <Button title="x" />;');
    await syncWorkspace(root);
    expect(db.query('SELECT path FROM files').all()).toEqual([{ path: join(root, 'App.tsx') }]);
    expect(db.query('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 0 });
  });

  it('collector respects glob, negation, anchored and nested ignore rules', async () => {
    const root = workspace();
    put(root, '.gitignore', 'ignored/**\n!ignored/Keep.ts\n/root-only.ts\n');
    put(root, 'ignored/Skip.ts', 'export {};');
    put(root, 'ignored/Keep.ts', 'export {};');
    put(root, 'root-only.ts', 'export {};');
    put(root, 'src/root-only.ts', 'export {};');
    put(root, 'src/.gitignore', '*.generated.ts\n');
    put(root, 'src/a.generated.ts', 'export {};');
    const files = (await collectFiles(root)).map(p => p.slice(root.length + 1)).sort();
    expect(files).toEqual(['ignored/Keep.ts', 'src/root-only.ts']);
  });

  it('watcher does not index files excluded by ignore globs', async () => {
    const root = workspace();
    put(root, '.gitignore', 'ignored/**\n');
    const db = getWorkspaceDatabase(root, { enableWatcher: false });
    const watcher = new WorkspaceWatcher(root, db, { debounceMs: 60_000 });
    watchers.push(watcher);
    put(root, 'ignored/Secret.ts', 'export const secret = 1;');
    (watcher as any).handleFsEvent('ignored/Secret.ts');
    await watcher.flushQueue();
    expect(db.query('SELECT path FROM files').all()).toEqual([]);
  });

  it('API extraction ignores comments and strings while retaining real call positions', () => {
    const code = '// fetch("/fake")\nconst text = `fetch("/text")`;\nfetch("/real", { method: "POST" });';
    const result = extractApiContractsFromCode(code, 'demo.ts');
    expect(result.map(({ endpoint, method, line, column }) => ({ endpoint, method, line, column }))).toEqual([
      { endpoint: '/real', method: 'POST', line: 3, column: 1 },
    ]);
  });

  it('API extraction preserves Vue script block coordinates', () => {
    const result = extractApiContractsFromCode('<template><div>fetch("/fake")</div></template>\n<script setup>\nfetch("/real");\n</script>', 'Demo.vue');
    expect(result.map(({ endpoint, line, column }) => ({ endpoint, line, column }))).toEqual([{ endpoint: '/real', line: 3, column: 1 }]);
  });

  it('API extraction includes Astro client scripts and excludes HTML comments', () => {
    const code = '---\nfetch("/server");\n---\n<!-- <script>fetch("/fake")</script> -->\n<script>fetch("/client");</script>';
    const result = extractApiContractsFromCode(code, 'Demo.astro');
    expect(result.map(({ endpoint, line, column }) => ({ endpoint, line, column }))).toEqual([
      { endpoint: '/server', line: 2, column: 1 },
      { endpoint: '/client', line: 5, column: 9 },
    ]);
  });

  it('API extraction retains real calls in Vue event expressions', () => {
    const result = extractApiContractsFromCode('<template>\n<button @click="fetch(\'/real\')">fetch("/text")</button>\n</template>', 'Demo.vue');
    expect(result.map(({ endpoint, line, column }) => ({ endpoint, line, column }))).toEqual([{ endpoint: '/real', line: 2, column: 17 }]);
  });
});
