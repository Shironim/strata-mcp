import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getComponentTree } from '../../src/engine/tree';
import { generatePatchPlan } from '../../src/engine/patch-plan';
import { clearLastKnownProjectRoot, setLastKnownProjectRoot } from '../../src/engine/path-resolver';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { coerceToolArguments, createMcpServer } from '../../src/mcp';
import { componentTreeTool } from '../../src/tools/component-tree';
import { patchPlanTool } from '../../src/tools/patch-plan';
import type { ComponentTreeNode, PatchPlanResult } from '../../src/types';

describe('tree and patch consumer scan root boundaries', () => {
  let root: string;
  let ui: string;
  let web: string;
  let button: string;
  let local: string;
  let app: string;
  const cwd = process.cwd();
  const indexed = new Set<string>();

  function write(path: string, content: string) {
    writeFileSync(path, content);
  }
  function index(path: string) {
    getWorkspaceDatabase(path, { create: true, enableWatcher: false });
    indexed.add(path);
  }
  function consumers(node: ComponentTreeNode): string[] {
    return [...new Set(node.children.flatMap(child => [child.filePath!, ...consumers(child)]))].sort();
  }
  function checkPatch(plan: PatchPlanResult, expected: string[]) {
    expect(plan.totalConsumersAudited).toBe(expected.length);
    expect(plan.patches.map(p => p.file).sort()).toEqual([...expected].sort());
    expect(plan.patches.every(p => p.newSnippet === 'title="Hi"')).toBe(true);
  }
  function parse(response: any) {
    expect(response.isError).toBeFalsy();
    const data = JSON.parse(response.content[0].text);
    expect(data.status).not.toBe('NOT_INDEXED');
    return data;
  }
  const rename = { refactor_type: 'rename_prop', old_name: 'label', new_name: 'title', format: 'json' };
  function cli(command: string, flags: string[] = [], cliCwd = root, entry = button) {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../src/mcp.ts'), command, entry,
      ...(command === 'tree' ? ['--direction', 'upward'] : ['--refactor', 'rename_prop', '--old', 'label', '--new', 'title']),
      '--json', ...flags], { cwd: cliCwd });
    expect(proc.exitCode).toBe(0);
    return JSON.parse(proc.stdout.toString());
  }

  beforeEach(() => {
    clearLastKnownProjectRoot();
    root = mkdtempSync('/tmp/strata-root-boundaries-');
    ui = join(root, 'packages/ui');
    web = join(root, 'apps/web');
    for (const path of [ui, web]) {
      mkdirSync(join(path, 'src'), { recursive: true });
      write(join(path, 'package.json'), '{}');
    }
    write(join(root, 'package.json'), '{}');
    button = join(ui, 'src/Button.vue');
    local = join(ui, 'src/Local.vue');
    app = join(web, 'src/App.vue');
    write(button, '<template><button/></template>');
    write(local, '<script setup>\nimport Button from "./Button.vue";\n</script>\n<template><Button label="Hi"/></template>');
    write(app, '<script setup>\nimport Button from "../../../packages/ui/src/Button.vue";\n</script>\n<template><Button label="Hi"/></template>');
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const path of indexed) closeWorkspaceDatabase(path);
    indexed.clear();
    clearLastKnownProjectRoot();
    rmSync(root, { recursive: true, force: true });
  });

  for (const choice of ['workspace', 'package', 'inferred', 'consumer-directory', 'relative-workspace'] as const) {
    it(`uses ${choice} root for direct tree and patch without requiring an index`, async () => {
      const targetPath = choice === 'workspace' ? root : choice === 'package' ? ui
        : choice === 'consumer-directory' ? join(web, 'src')
        : choice === 'relative-workspace' ? relative(cwd, root) : undefined;
      const expected = choice === 'workspace' || choice === 'relative-workspace' ? [local, app]
        : choice === 'consumer-directory' ? [app] : [local];
      const tree = await getComponentTree({ entryPath: button, direction: 'upward', targetPath });
      expect(tree.root.filePath).toBe(button);
      expect(consumers(tree.root)).toEqual(expected.sort());
      checkPatch(await generatePatchPlan({ componentPath: button, refactorType: 'rename_prop', oldName: 'label', newName: 'title', targetPath }), expected);
      expect(existsSync(join(root, '.strata'))).toBe(false);
      expect(existsSync(join(ui, '.strata'))).toBe(false);
    });
  }

  for (const rootKey of ['target_path', 'targetPath', 'root', 'workspace_root', 'workspaceRoot', 'project_root', 'projectRoot']) {
    it(`preserves ${rootKey} through coercion and MCP dispatch/worker`, async () => {
      index(root);
      const server = createMcpServer();
      try {
        const args = { path: button, [rootKey]: root, format: 'json' };
        for (const name of ['get_component_tree', 'generate_patch_plan']) {
          expect(coerceToolArguments(name, args).target_path).toBe(root);
        }
        const call = (server as any)._requestHandlers.get('tools/call');
        const tree = parse(await call({ method: 'tools/call', params: { name: 'get_component_tree', arguments: { ...args, direction: 'upward' } } }));
        expect(consumers(tree.root)).toEqual([local, app].sort());
        const plan = parse(await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: { ...args, ...rename } } }));
        checkPatch(plan, [local, app]);
      } finally { await server.close(); }
    });
  }

  it('uses the explicit workspace for direct patch even with nested package markers', async () => {
    checkPatch(await generatePatchPlan({ componentPath: button, targetPath: root, refactorType: 'rename_prop', oldName: 'label', newName: 'title' }), [local, app]);
  });

  it('propagates the explicit workspace through patch dispatch/worker', async () => {
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      checkPatch(parse(await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: { path: button, target_path: root, ...rename } } })), [local, app]);
    } finally { await server.close(); }
  });

  it('propagates the explicit workspace through patch CLI', () => {
    checkPatch(cli('patch-plan', ['--path', root]), [local, app]);
  });

  for (const choice of ['package', 'inferred', 'consumer-directory'] as const) {
    it(`preserves ${choice} boundary through MCP worker`, async () => {
      const scanRoot = choice === 'consumer-directory' ? join(web, 'src') : ui;
      index(scanRoot);
      setLastKnownProjectRoot(root);
      const server = createMcpServer();
      try {
        const args = { path: button, ...(choice === 'inferred' ? {} : { target_path: scanRoot }), format: 'json' };
        const expected = choice === 'consumer-directory' ? [app] : [local];
        const call = (server as any)._requestHandlers.get('tools/call');
        const tree = parse(await call({ method: 'tools/call', params: { name: 'get_component_tree', arguments: { ...args, direction: 'upward' } } }));
        expect(consumers(tree.root)).toEqual(expected);
        checkPatch(parse(await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: { ...args, ...rename } } })), expected);
      } finally { await server.close(); }
    });
  }

  it('keeps file aliases distinct from camelCase roots', async () => {
    index(root);
    for (const key of ['entry_path', 'entryPath', 'file_path', 'filePath', 'component_path', 'componentPath']) {
      const args = coerceToolArguments('get_component_tree', { [key]: button, targetPath: root, direction: 'upward', format: 'json' });
      expect(args.path).toBe(button);
      expect(consumers(parse(await componentTreeTool.handler(args)).root)).toEqual([local, app].sort());
    }
    for (const key of ['file_path', 'filePath', 'component_path', 'componentPath']) {
      checkPatch(parse(await patchPlanTool.handler(coerceToolArguments('generate_patch_plan', { [key]: button, targetPath: root, ...rename }))), [local, app]);
    }
  });

  it('infers the package for a legacy file target instead of using its parent directory', async () => {
    index(ui);
    const tree = parse(await componentTreeTool.handler(coerceToolArguments('get_component_tree', { targetPath: button, direction: 'upward', format: 'json' })));
    expect(consumers(tree.root)).toEqual([local]);
  });

  it('retains a legacy target file when a separate root alias overrides the scan directory', async () => {
    index(root);
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      const tree = parse(await call({ method: 'tools/call', params: { name: 'get_component_tree', arguments: { targetPath: button, root, direction: 'upward', format: 'json' } } }));
      expect(consumers(tree.root)).toEqual([local, app].sort());
    } finally { await server.close(); }
  });

  it('accepts a directory path alias alongside a separate entry file', async () => {
    index(root);
    const tree = parse(await componentTreeTool.handler(coerceToolArguments('get_component_tree', { path: root, entry_path: button, direction: 'upward', format: 'json' })));
    expect(consumers(tree.root)).toEqual([local, app].sort());
  });

  for (const explicitRoot of [false, true]) {
    it(`preserves a legacy patch target file ${explicitRoot ? 'with' : 'without'} a separate root`, async () => {
      const server = createMcpServer();
      try {
        const call = (server as any)._requestHandlers.get('tools/call');
        const plan = parse(await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: { targetPath: button, ...(explicitRoot ? { root } : {}), ...rename } } }));
        checkPatch(plan, explicitRoot ? [local, app] : [local]);
      } finally { await server.close(); }
    });
  }

  it('uses explicit dot as cwd despite stale session root and a second workspace', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    write(join(other, 'package.json'), '{}');
    write(join(other, 'Unrelated.vue'), '<template><Button label="Hi"/></template>');
    index(other);
    index(web);
    process.chdir(web);
    setLastKnownProjectRoot(other);
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      const args = { path: button, targetPath: '.', format: 'json' };
      const tree = parse(await call({ method: 'tools/call', params: { name: 'get_component_tree', arguments: { ...args, direction: 'upward' } } }));
      expect(consumers(tree.root)).toEqual([app]);
      checkPatch(parse(await call({ method: 'tools/call', params: { name: 'generate_patch_plan', arguments: { ...args, ...rename } } })), [app]);
    } finally { await server.close(); }
  });

  for (const choice of ['workspace', 'package', 'inferred', 'consumer-directory', 'dot'] as const) {
    it(`uses ${choice} root through CLI from a controlled cwd`, () => {
      const flags = choice === 'inferred' ? [] : ['--path', choice === 'workspace' ? root
        : choice === 'package' ? ui : choice === 'consumer-directory' ? join(web, 'src') : '.'];
      const expected = choice === 'workspace' || choice === 'dot' ? [local, app]
        : choice === 'consumer-directory' ? [app] : [local];
      expect(consumers(cli('tree', flags).root)).toEqual(expected.sort());
      checkPatch(cli('patch-plan', flags), expected);
    });
  }

  it('resolves explicit alias overrides relative to the selected scan root', async () => {
    write(app, '<script setup>\nimport Renamed from "@shared/Button.vue";\n</script>\n<template><Renamed label="Hi"/></template>');
    const tree = await getComponentTree({ entryPath: button, targetPath: root, direction: 'upward', aliasMap: { '@shared/': 'packages/ui/src/' } });
    expect(consumers(tree.root)).toEqual([local, app].sort());
  });

  it('preserves scope as a traversal boundary', async () => {
    const tree = await getComponentTree({ entryPath: button, targetPath: root, direction: 'upward', scopeFilter: 'apps/web' });
    expect(tree.root.isExternalScope).toBe(true);
    expect(tree.root.children).toEqual([]);
    const localScope = await getComponentTree({ entryPath: button, targetPath: root, direction: 'upward', scopeFilter: 'packages/ui' });
    expect(consumers(localScope.root)).toEqual([local, app].sort());
    expect(localScope.root.children.find(n => n.filePath === app)?.isExternalScope).toBe(true);
  });

  it('preserves downward trees and the default route root in CLI and MCP', async () => {
    mkdirSync(join(root, 'pages'));
    const page = join(root, 'pages/index.vue');
    write(page, '<script setup>\nimport Local from "../packages/ui/src/Local.vue";\n</script>\n<template><Local/></template>');
    index(root);
    const downward = await getComponentTree({ entryPath: local, targetPath: root });
    expect(downward.root.children.map(n => n.filePath)).toContain(button);
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../src/mcp.ts'), 'tree', '--route', '/', '--json'], { cwd: root });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).root.filePath).toBe(page);
    process.chdir(root);
    clearLastKnownProjectRoot();
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      const tree = parse(await call({ method: 'tools/call', params: { name: 'get_component_tree', arguments: { route: '/', format: 'json' } } }));
      expect(tree.root.filePath).toBe(page);
    } finally { await server.close(); }
  });
});
