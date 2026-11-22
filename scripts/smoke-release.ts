import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { version } from '../package.json';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: bun scripts/smoke-release.ts <absolute executable path> [args]');

const cwd = await mkdtemp(join(tmpdir(), 'strata-release-'));
const env = { ...process.env };
delete env.STRATA_APP_HTML;
const client = new Client({ name: 'strata-release-smoke', version });

try {
  const result = Bun.spawnSync([command, ...args, '--version'], { cwd, env, timeout: 10_000 });
  const reportedVersion = result.stdout.toString().trim();
  if (result.exitCode !== 0 || reportedVersion !== version) {
    throw new Error(`Expected CLI version ${version}, got "${reportedVersion}": ${result.stderr}`);
  }

  const transport = new StdioClientTransport({ command, args: [...args, 'serve'], cwd, env });
  await client.connect(transport, { timeout: 10_000 });
  const { tools } = await client.listTools(undefined, { timeout: 10_000 });
  if (tools.length !== 5 || !tools.some((tool) => tool.name === 'map_workspace')) {
    throw new Error(`Unexpected MCP tool list: ${tools.map((tool) => tool.name).join(', ')}`);
  }

  const uri = 'ui://strata/explorer.html';
  const { contents } = await client.readResource({ uri }, { timeout: 10_000 });
  if (!contents.some((content) =>
    content.uri === uri &&
    content.mimeType === 'text/html;profile=mcp-app' &&
    typeof content.text === 'string' &&
    content.text.includes('<title>Strata Explorer</title>') &&
    content.text.includes('<script type="module">')
  )) {
    throw new Error('MCP resource did not return the bundled Strata Explorer HTML');
  }
  console.log(`Strata ${version}: MCP handshake, five tools, and Explorer resource passed.`);
} finally {
  try {
    await client.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
