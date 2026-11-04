import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Run after `bun run build`; this checks Strata's build, not React/Next application compilation.
const root = await mkdtemp(join(tmpdir(), 'strata-react-next-build-smoke-'));
const write = async (path: string, content: string) => {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
};
await write('package.json', '{"dependencies":{"react":"19","next":"15"}}');
await write('next.config.js', 'export default {}');
await write('props.ts', 'export interface Input<T> {value:T; label?:string}');
await write('Card.tsx', `import type {Input} from './props'; export default function Card(props:Input<number>){return <div/>}`);
await write('app/layout.tsx', `export const revalidate=30; export const preferredRegion='iad1'; export default function Layout(){return null}`);
await write('app/page.tsx', `export const revalidate=60; export const preferredRegion=selectRegion(); export default function Page(){return null}`);
await write('theme.ts', `import {createContext} from 'react'; export const ThemeContext=createContext(null)`);
await write('app/Bound.tsx', `import {useState as state} from 'react'; export default function Bound(){state(0);return null}`);
await write('app/Decoy.tsx', `import {useState} from 'react'; const text='useState(0)';
  export default function Decoy(useState:any){useState(0);return null}`);
await write('app/Dom.tsx', `export default function Dom(){return <input onInputCapture={handler}/>} `);
await write('app/EventDecoy.tsx', `const text='onClick=handler';export default function EventDecoy(){return <Client onClick={handler}/>} `);
await write('Hooks.tsx', `import {use,useContext as read,useState} from 'react'; import {ThemeContext} from './theme';
  export default function Hooks(){const [name]=useState('not-a-store');const theme=read(ThemeContext);
    function shadow(read:any){return read(FakeContext)};const pending=use(PendingResource);return <div/>}`);

const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../../dist/mcp.js')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
const timeout = setTimeout(() => proc.kill(), 30000);
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = '';
function send(message: object) { proc.stdin.write(JSON.stringify(message) + '\n'); proc.stdin.flush(); }
async function receive(id: number): Promise<any> {
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.id === id) return message; } catch {}
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`MCP closed before response ${id}`);
    buffer += decoder.decode(chunk.value, { stream: true });
  }
}
async function call(id: number, name: string, args: object) {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const response = (await receive(id)).result;
  assert.ok(response && !response.isError, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'react-next-parser-smoke', version: '1' } } });
  assert.ok((await receive(1)).result);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const react = await call(2, 'inspect_component', { path: join(root, 'Card.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.ok(react.props.some((prop: any) => prop.name === 'value' && prop.type === 'number'));
  assert.ok(react.dependencies.some((dep: any) => dep.path === join(root, 'props.ts') && /^[a-f0-9]{64}$/.test(dep.hash)));
  const routes = await call(3, 'audit_frontend', { path: root, target: 'routes', format: 'json' });
  const page = routes.routes.find((route: any) => route.type === 'page');
  assert.equal(page.nextEffectiveSegmentConfig.config.revalidate, 30);
  assert.equal(page.nextEffectiveSegmentConfig.config.preferredRegion, undefined);
  assert.equal(page.nextEffectiveSegmentConfig.sources.length, 2);
  assert.ok(routes.retrieval.omissions.some((issue: any) => issue.code === 'NEXT_EFFECTIVE_CONFIG_PARTIAL'));
  const summary = await call(4, 'audit_frontend', { path: root, target: 'routes', format: 'json', response_detail: 'summary' });
  assert.ok(summary.retrieval.omissions.some((issue: any) => issue.code === 'NEXT_EFFECTIVE_CONFIG_PARTIAL'));
  const hooks = await call(5, 'inspect_component', { path: join(root, 'Hooks.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.deepEqual(hooks.stateDependencies.stores, []);
  assert.deepEqual(hooks.stateDependencies.contexts, ['ThemeContext']);
  assert.ok(hooks.retrieval.omissions.some((issue: any) => issue.code === 'REACT_USE_RESOURCE_UNVERIFIED'));
  const bound = await call(6, 'inspect_component', { path: join(root, 'app/Bound.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.ok(bound.renderBoundary.violations.some((issue: any) => issue.code === 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT'));
  const decoy = await call(7, 'inspect_component', { path: join(root, 'app/Decoy.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.ok(!decoy.renderBoundary.violations?.some((issue: any) => issue.code === 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT'));
  const dom = await call(8, 'inspect_component', { path: join(root, 'app/Dom.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.ok(dom.renderBoundary.violations.some((issue: any) => issue.code === 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT' && issue.message.includes('onInputCapture')));
  const eventDecoy = await call(9, 'inspect_component', { path: join(root, 'app/EventDecoy.tsx'), project_root: root, format: 'json', resolve_globals: false });
  assert.ok(!eventDecoy.renderBoundary.violations?.some((issue: any) => issue.code === 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT'));
  console.log('PASS: built MCP stdio — React props/hashes and scoped hook/context dependencies; Next layout config, partial summary and lexical hook/AST DOM diagnostics');
} finally {
  clearTimeout(timeout);
  proc.kill();
  await proc.exited;
  await rm(root, { recursive: true, force: true });
}
