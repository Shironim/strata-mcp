import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Run after `bun run build`; all analyzed project files live in a disposable directory.
const root = await mkdtemp(join(tmpdir(), 'strata-nuxt-build-smoke-'));
const write = async (path: string, content: string) => {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
};
await write('nuxt.config.ts', `import settings from './settings'; export default defineNuxtConfig({...settings, extends:['@fixture/theme','github:fixture/theme#v1'], imports:{dirs:['helpers/*/index.{ts,js}']}})`);
await write('settings.ts', 'export default {ssr:true}');
await write('layers/local/utils/local.ts', 'export function autoHandler(){}');
await write('node_modules/@fixture/theme/package.json', '{"name":"@fixture/theme","exports":{".":"./nuxt.config.ts"}}');
await write('node_modules/@fixture/theme/nuxt.config.ts', 'export default {}');
await write('node_modules/@fixture/theme/utils/theme.ts', 'export function packageHandler(){}');
await write('helpers/group/index.ts', `export * from '../../logic';`);
await write('logic.ts', 'export function globHandler(){}; export interface Hidden {}');
await write('Home.vue', '<template><button @click="autoHandler"/><button @click="packageHandler"/><button @click="globHandler"/></template>');

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
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nuxt-config-smoke', version: '1' } } });
  assert.ok((await receive(1)).result);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [index, response_detail] of ['full', 'summary'].entries()) {
    const id = index + 2;
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'inspect_component', arguments: {
      path: join(root, 'Home.vue'), project_root: root, audit_events: true, resolve_globals: false, format: 'json', response_detail,
    } } });
    const response = (await receive(id)).result;
    assert.ok(response && !response.isError, JSON.stringify(response));
    const result = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.ok(result.retrieval.omissions.some((item: any) => item.code === 'NUXT_AUTO_IMPORT_PARTIAL'));
    assert.equal(result.decision.status, 'partial');
    if (response_detail === 'full') {
      assert.deepEqual(result.eventAudit.candidateHandlers.map((item: any) => item.handlerName).sort(), ['autoHandler', 'globHandler', 'packageHandler']);
      assert.ok(result.eventAudit.autoImportDependencies.some((item: any) => item.path === join(root, 'settings.ts') && /^[a-f0-9]{64}$/.test(item.hash)));
      assert.ok(result.dependencies.some((item: any) => item.path === join(root, 'logic.ts')));
    }
  }
  console.log('PASS: built MCP stdio — package/auto/glob candidates, config/export hashes, remote omission, full/summary partial decisions');
} finally {
  clearTimeout(timeout);
  proc.kill();
  await proc.exited;
  await rm(root, { recursive: true, force: true });
}
