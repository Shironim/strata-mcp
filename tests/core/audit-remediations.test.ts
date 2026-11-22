import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSemanticPool,
  defaultWarmDbPool,
  inspectFile,
  mapWorkspace,
  queryGraph,
  readSlice,
  searchCode,
  syncWorkspaceV3,
} from '../../src/engine/v2';

const tempDirs: string[] = [];

function createTempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

afterEach(() => {
  defaultSemanticPool.disposeAll();
  defaultWarmDbPool.closeAll();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Audit Remediations (Phases 1-6)', () => {
  test('Phase 1 & 2: resolves @/ aliases, Vue Router dynamic imports, Axios/SWR HTTP, and DYNAMIC method', async () => {
    const root = createTempWorkspace('strata-audit-p12-');
    writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'vue-alias-app',
        dependencies: { vue: '^3.5.0', 'vue-router': '^4.4.0', axios: '^1.7.0' },
      })
    );
    writeFile(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      })
    );
    writeFile(root, 'src/api.ts', `const api = { get: (u: string) => u, post: (u: string, d?: any) => u };\nexport default api;\n`);
    writeFile(root, 'src/components/LogoClaude.vue', `<template><span>Claude</span></template>\n`);
    writeFile(root, 'src/ai/models.ts', `import LogoClaude from '@/components/LogoClaude.vue';\nexport const icons = { claude: LogoClaude };\n`);
    writeFile(root, 'src/routes/login/LoginView.vue', `<template><div>Login</div></template>\n`);
    writeFile(
      root,
      'src/routes/register/RegisterForm.vue',
      `<script setup lang="ts">
import api from '@/api';
async function onSubmit() {
  await api.post('/users/register', {});
}
</script>
<template><form @submit.prevent="onSubmit"><button type="submit">Go</button></form></template>
`
    );
    writeFile(
      root,
      'src/router.ts',
      `import { createRouter } from 'vue-router';
export const router = createRouter({
  routes: [
    { path: '/', redirect: '/login' },
    { path: '/login', component: () => import('@/routes/login/LoginView.vue') },
    { path: '/register', component: () => import('@/routes/register/RegisterForm.vue') },
  ],
});
`
    );
    writeFile(
      root,
      'src/composables/useDynamicFetch.ts',
      `export async function submitDynamic(endpoint: { url: string; method: string }) {
  return fetch(endpoint.url, { method: endpoint.method });
}
export function useLinksSwr() {
  return useSWR('/api/links', (u: string) => fetch(u));
}
declare function useSWR(key: string, fetcher: any): any;
`
    );

    await syncWorkspaceV3(root, { force: true });

    // Phase 1: Vue Router routes resolved via @/
    const routesEnv = await mapWorkspace({ workspaceRoot: root, view: 'routes' });
    const routePaths = routesEnv.data.routes?.map((r) => r.urlPath) ?? [];
    expect(routePaths).toContain('/');
    expect(routePaths).toContain('/login');
    expect(routePaths).toContain('/register');

    // Phase 1: @/ imports resolved and LogoClaude not flagged as unused
    const regInspect = await inspectFile({
      workspaceRoot: root,
      path: 'src/routes/register/RegisterForm.vue',
      sections: ['imports', 'boundaries'],
    });
    const apiImp = regInspect.data.imports?.find((i) => i.specifier === '@/api');
    expect(apiImp?.resolvedFilePath).toBe(join(root, 'src/api.ts'));

    const healthEnv = await mapWorkspace({ workspaceRoot: root, view: 'health' });
    const unusedNames = healthEnv.data.health?.unusedComponents.map((c) => c.name) ?? [];
    expect(unusedNames).not.toContain('LogoClaude');

    // Phase 2: Axios `api.post` detected
    expect(regInspect.data.boundaries?.outboundHttp.some((b) => b.method === 'POST' && b.url === '/users/register')).toBe(true);

    // Phase 2: Dynamic fetch method reported as DYNAMIC + diagnostic, and useSWR detected
    const dynInspect = await inspectFile({
      workspaceRoot: root,
      path: 'src/composables/useDynamicFetch.ts',
      sections: ['boundaries'],
    });
    const httpItems = dynInspect.data.boundaries?.outboundHttp ?? [];
    expect(httpItems.some((b) => b.method === 'DYNAMIC' && b.url === 'endpoint.url')).toBe(true);
    expect(httpItems.some((b) => b.client === 'useSWR' && b.url === '/api/links')).toBe(true);
    expect(dynInspect.diagnostics.some((d) => d.code === 'DYNAMIC_HTTP_METHOD')).toBe(true);

    // Phase 5: callHierarchy finds template @submit.prevent="onSubmit"
    const callEnv = await queryGraph({
      workspaceRoot: root,
      query: 'callHierarchy',
      direction: 'up',
      target: { file: 'src/routes/register/RegisterForm.vue', symbol: 'onSubmit' },
    });
    expect(callEnv.data.items?.some((i) => i.kind.includes('listens_event') && i.snippet.includes('onSubmit'))).toBe(true);
  });

  test('Phase 3 & 4: extracts forwardRef props, defineEmits<Interface>(), unresolved diagnostic, and excludes Next.js route.tsx from health', async () => {
    const root = createTempWorkspace('strata-audit-p34-');
    writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'hybrid-contracts',
        dependencies: { react: '^18.3.0', next: '^15.0.0', vue: '^3.5.0' },
      })
    );
    writeFile(root, 'next.config.mjs', 'export default {};\n');
    writeFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true } }));

    writeFile(
      root,
      'components/Button.tsx',
      `import { forwardRef } from 'react';
export interface ButtonProps {
  text?: string;
  variant?: 'primary' | 'secondary';
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ text, variant, loading }, ref) => {
  return <button ref={ref} data-variant={variant}>{loading ? '...' : text}</button>;
});
`
    );
    writeFile(
      root,
      'components/VButton.vue',
      `<script setup lang="ts">
interface VButtonEmits {
  (e: 'click', ev?: MouseEvent): void;
  (e: 'change', val: string): void;
}
defineProps<{ loading?: boolean }>();
const emit = defineEmits<VButtonEmits>();
</script>
<template><button @click="emit('click')"><slot /></button></template>
`
    );
    writeFile(
      root,
      'app/api/auth/saml/route.tsx',
      `export async function POST() { return new Response('ok'); }\nexport async function GET() { return new Response('ok'); }\n`
    );

    await syncWorkspaceV3(root, { force: true });

    // Phase 3: forwardRef props
    const btnInspect = await inspectFile({
      workspaceRoot: root,
      path: 'components/Button.tsx',
      sections: ['contract'],
      resolveTypes: true,
    });
    const propNames = btnInspect.data.contract?.props.map((p) => p.name) ?? [];
    expect(propNames).toContain('text');
    expect(propNames).toContain('variant');
    expect(propNames).toContain('loading');

    // Phase 3: defineEmits<VButtonEmits>()
    const vbtnInspect = await inspectFile({
      workspaceRoot: root,
      path: 'components/VButton.vue',
      sections: ['contract'],
      resolveTypes: true,
    });
    expect(vbtnInspect.data.contract?.emits).toEqual(expect.arrayContaining(['click', 'change']));

    // Phase 3: resolve_types=false emits diagnostic
    const vbtnNoTypes = await inspectFile({
      workspaceRoot: root,
      path: 'components/VButton.vue',
      sections: ['contract'],
      resolveTypes: false,
    });
    expect(vbtnNoTypes.diagnostics.some((d) => d.code === 'CONTRACT_TYPES_UNRESOLVED')).toBe(true);

    // Phase 4: Next.js route.tsx POST/GET not in health unusedComponents
    const healthEnv = await mapWorkspace({ workspaceRoot: root, view: 'health' });
    const unusedNames = healthEnv.data.health?.unusedComponents.map((c) => c.name) ?? [];
    expect(unusedNames).not.toContain('POST');
    expect(unusedNames).not.toContain('GET');
  });

  test('Phase 5 & 6: tracks React Context stateFlow, bounds componentTree without barrel nodes, windows minified lines, and indexes nested/default symbols', async () => {
    const root = createTempWorkspace('strata-audit-p56-');
    writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'context-and-minified',
        dependencies: { react: '^18.3.0' },
      })
    );
    writeFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve' } }));

    writeFile(
      root,
      'src/context/LinksContext.tsx',
      `import { createContext } from 'react';
export const LinksListContext = createContext<{ viewMode: string }>({ viewMode: 'cards' });
`
    );
    writeFile(
      root,
      'src/components/ChildCard.tsx',
      `import { useContext } from 'react';
import { LinksListContext } from '../context/LinksContext';
export function ChildCard() {
  const ctx = useContext(LinksListContext);
  return <div>{ctx.viewMode}</div>;
}
`
    );
    writeFile(root, 'src/components/index.ts', `export { ChildCard } from './ChildCard';\n`);
    writeFile(
      root,
      'src/components/ContainerA.tsx',
      `import { ChildCard } from './index';
import { LinksListContext } from '../context/LinksContext';
export function ContainerA() {
  return <LinksListContext.Provider value={{ viewMode: 'rows' }}><ChildCard /></LinksListContext.Provider>;
}
`
    );
    writeFile(
      root,
      'src/components/ContainerB.tsx',
      `import { ChildCard } from './ChildCard';
export function ContainerB() { return <ChildCard />; }
`
    );

    // Phase 6: Minified bundle > 100KB on single line + nested callable + export default plugin
    const padding = 'a=1,'.repeat(30000); // ~120KB on one line
    writeFile(root, 'src/assets/chart.js', `/* Minified */\nfunction init(){var ${padding}b="ViteTargetMarker";return b;}\n`);
    writeFile(
      root,
      'src/plugins/axios.js',
      `export default {\n  install(app) {\n    const debouncedHandler = function (e) { return e; };\n    return debouncedHandler;\n  }\n};\n`
    );

    await syncWorkspaceV3(root, { force: true });

    // Phase 5: React Context stateFlow
    const stateEnv = await queryGraph({
      workspaceRoot: root,
      query: 'stateFlow',
      target: { symbol: 'LinksListContext' },
    });
    const kinds = stateEnv.data.items?.map((i) => i.kind) ?? [];
    expect(kinds).toContain('provides_context');
    expect(kinds).toContain('consumes_context');

    // Phase 5: componentTree excludes barrel index.ts and respects limit=1
    const treeEnv = await queryGraph({
      workspaceRoot: root,
      query: 'componentTree',
      direction: 'up',
      target: { file: 'src/components/ChildCard.tsx' },
      limit: 1,
    });
    const children = treeEnv.data.tree?.children ?? [];
    expect(children.length).toBe(1);
    expect(children[0]!.relPath).not.toContain('index.ts');
    expect(treeEnv.diagnostics.some((d) => d.code === 'COMPONENT_TREE_TRUNCATED')).toBe(true);

    // Phase 6: Minified line windowed safely in readSlice
    const searchRes = await searchCode({
      workspaceRoot: root,
      query: 'ViteTargetMarker',
      kind: 'text',
    });
    expect(searchRes.data.matches.length).toBeGreaterThan(0);
    const sliceRes = await readSlice({
      workspaceRoot: root,
      sourceRef: searchRes.data.matches[0]!.sourceRef,
    });
    expect(sliceRes.data.content).toContain('ViteTargetMarker');
    expect(sliceRes.data.content.length).toBeLessThan(2000);
    expect(sliceRes.diagnostics.some((d) => d.code === 'MINIFIED_LINE_WINDOWED')).toBe(true);

    // Phase 6: export default { install } & nested debouncedHandler indexed
    const axiosInspect = await inspectFile({
      workspaceRoot: root,
      path: 'src/plugins/axios.js',
      sections: ['outline'],
    });
    const outlineNames = axiosInspect.data.outline?.map((o) => o.name) ?? [];
    expect(outlineNames).toContain('install');
    expect(outlineNames).toContain('debouncedHandler');
  });
});
