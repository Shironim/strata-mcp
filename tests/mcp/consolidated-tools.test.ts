import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditFrontendTool } from '../../src/tools';
import { clearLastKnownProjectRoot } from '../../src/engine/path-resolver';
import { createMcpServer } from '../../src/mcp';
import { TOOL_CATALOG } from '../../src/tools/catalog';
import { STRATA_INSPECT_SKILL } from '../../src/cli/templates';

describe('routes and API contracts through audit_frontend', () => {
  let root: string;
  beforeEach(() => {
    clearLastKnownProjectRoot();
    root = mkdtempSync('/tmp/strata-six-tools-');
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"next":"15"}}');
    mkdirSync(join(root, 'pages'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'legacy'));
    writeFileSync(join(root, 'pages/index.tsx'), 'export default function Page() { return <div/> }');
    writeFileSync(join(root, 'pages/account.tsx'), 'export default function Account() { return <div/> }');
    writeFileSync(join(root, 'src/client.ts'), 'fetch("/api/current", {method: "POST"});');
    writeFileSync(join(root, 'legacy/client.ts'), 'fetch("/api/legacy");');
  });
  afterEach(() => {
    clearLastKnownProjectRoot();
    rmSync(root, { recursive: true, force: true });
  });

  for (const view of ['summary', 'full', 'tree']) {
    it(`preserves routes view ${view}, framework, prefix and path aliases`, async () => {
      const response = await auditFrontendTool.handler({
        target: 'routes', targetPath: root, framework_hint: 'next-pages', prefix: '/account', view, format: 'json',
      });
      expect(response.isError).toBeFalsy();
      const data = JSON.parse(response.content[0].text);
      expect(data.viewMode).toBe(view);
      expect(data.framework).toBe('next-pages');
      expect(data.routes.map((r: any) => r.path)).toEqual(['/account']);
      expect(existsSync(join(root, '.strata'))).toBe(false);
    });
  }

  it('defaults targeted route discovery to summary and supports text', async () => {
    const json = await auditFrontendTool.handler({ path: root, target: 'routes', format: 'json' });
    expect(JSON.parse(json.content[0].text).viewMode).toBe('summary');
    const text = await auditFrontendTool.handler({ path: root, target: 'routes', view: 'tree' });
    expect(text.isError).toBeFalsy();
    expect(text.content[0].text).toContain('Route Manifest');
  });

  it('preserves API scope and exclusion without triggering full audit/indexing', async () => {
    const scoped = await auditFrontendTool.handler({
      target: 'api-contracts', target_path: root, scopePath: 'src', format: 'json',
    });
    expect(scoped.isError).toBeFalsy();
    const data = JSON.parse(scoped.content[0].text);
    expect(data.endpointSummary['/api/current'].methods).toEqual(['POST']);
    expect(data.endpointSummary['/api/legacy']).toBeUndefined();
    expect(data.routes).toBeUndefined();
    const excluded = await auditFrontendTool.handler({
      path: root, target: 'api-contracts', exclude_dirs: ['legacy'], format: 'json',
    });
    expect(JSON.parse(excluded.content[0].text).endpointSummary['/api/legacy']).toBeUndefined();
    expect(existsSync(join(root, '.strata'))).toBe(false);
  });

  it('dispatches both targets through the MCP analysis worker', async () => {
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      for (const target of ['routes', 'api-contracts']) {
        const response = await call({ method: 'tools/call', params: {
          name: 'audit_frontend', arguments: { path: root, target, view: 'full', format: 'json' },
        }});
        expect(response.isError).toBeFalsy();
        const data = JSON.parse(response.content[0].text);
        if (target === 'routes') expect(data.viewMode).toBe('full');
        else expect(data.endpointSummary['/api/current']).toBeDefined();
      }
    } finally { await server.close(); }
  });

  it('advertises route view on audit_frontend and rejects removed tool names', async () => {
    expect(TOOL_CATALOG).toHaveLength(6);
    const audit = TOOL_CATALOG.find(tool => tool.name === 'audit_frontend')!;
    expect((audit.inputSchema.properties?.view as any).enum).toEqual(['summary', 'full', 'tree']);
    expect(STRATA_INSPECT_SKILL).not.toMatch(/get_routes|get_api_contracts/);
    const server = createMcpServer();
    try {
      const call = (server as any)._requestHandlers.get('tools/call');
      for (const name of ['get_routes', 'get_api_contracts']) {
        const response = await call({ method: 'tools/call', params: { name, arguments: { path: root } } });
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('audit_frontend');
      }
    } finally { await server.close(); }
  });

  it('keeps CLI routes/apis and consolidated audit targets consistent', async () => {
    const cli = join(import.meta.dir, '../../src/mcp.ts');
    for (const target of ['routes', 'api-contracts']) {
      const options = target === 'routes' ? ['--view', 'tree', '--prefix', '/account'] : ['--scope-path', 'src'];
      const run = (args: string[]) => {
        const result = Bun.spawnSync([process.execPath, cli, ...args, '--json'], { cwd: root });
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout.toString());
      };
      const direct = run([target === 'routes' ? 'routes' : 'apis', root, ...options]);
      const audit = run(['audit', root, '--target', target, ...options]);
      const response = await auditFrontendTool.handler({ path: root, target,
        view: 'tree', prefix: '/account', scope_path: target === 'routes' ? 'pages' : 'src', format: 'json' });
      const mcp = JSON.parse(response.content[0].text);
      if (target === 'routes') {
        expect(audit.routes).toEqual(direct.routes);
        expect(mcp.routes).toEqual(direct.routes);
        expect(audit.viewMode).toBe('tree');
      } else {
        expect(audit.endpointSummary).toEqual(direct.endpointSummary);
        expect(mcp.endpointSummary).toEqual(direct.endpointSummary);
      }
    }
  });
});
