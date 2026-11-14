import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { auditFrontendTool } from '../../src/tools/audit-frontend';
import { traceStateTool } from '../../src/tools/trace-state';
import { getDownwardComponentTree } from '../../src/engine/graph/downward-traversal';
import { closeAllDatabases, getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { extractTemplateExpressions } from '../../src/engine/template';

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync('/tmp/strata-analysis-regression-');
  roots.push(root);
  put(root, 'package.json', JSON.stringify({ dependencies: { vue: '3', react: '19' } }));
  return root;
}
function put(root: string, file: string, content: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  closeAllDatabases();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  ["import {AuthShellSimple} from './components/auth-shell';", '<AuthShellSimple/>'],
  ["import {AuthShellSimple as Shell} from './components/auth-shell';", '<Shell/>'],
  ["import * as Auth from './components/auth-shell';", '<Auth.AuthShellSimple/>'],
  ["import {PublicShell as Shell} from './components';", '<Shell/>'],
])('dead-components follows rendered named imports: %s', async (binding, jsx) => {
  const root = workspace();
  put(root, 'src/components/auth-shell.tsx', 'export function AuthShellSimple(){return <section/>} export function Other(){return <aside/>}');
  put(root, 'src/components/index.ts', "export {AuthShellSimple as PublicShell} from './auth-shell';");
  put(root, 'src/components/import-only.tsx', 'export function ImportedOnly(){return <p/>}');
  put(root, 'src/Login.tsx', `${binding}\nimport {ImportedOnly} from './components/import-only';\nexport function Login(){return ${jsx}}`);
  const response = await auditFrontendTool.handler({ target_path: root, target: 'dead-components', format: 'json' });
  expect(response.isError).not.toBe(true);
  const unused = (response.structuredContent as any).unusedComponents.map((c: any) => c.fileName);
  expect(unused).not.toContain('auth-shell.tsx');
  expect(unused).toContain('import-only.tsx');
});

test('a shadowed JSX import does not make a named-export module live', async () => {
  const root = workspace();
  put(root, 'src/auth-shell.tsx', 'export function AuthShellSimple(){return <p/>}');
  put(root, 'src/Other.tsx', "import {AuthShellSimple as Shell} from './auth-shell'; export function Other({Shell}){return <Shell/>}");
  const response = await auditFrontendTool.handler({ target_path: root, target: 'dead-components', format: 'json' });
  expect((response.structuredContent as any).unusedComponents.map((c: any) => c.fileName)).toContain('auth-shell.tsx');
});
