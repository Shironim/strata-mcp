import { readFileSync, writeFileSync } from 'node:fs';
import { findTool } from './tools';
import { closeAllDatabases } from './engine/storage/schema';
import { setLastKnownProjectRoot } from './engine/path-resolver';
import { ANALYSIS_LIMITS } from './analysis-supervisor';
import type { ToolCallResponse } from './tools/types';

async function main(): Promise<void> {
  let response: ToolCallResponse;
  try {
    const input = readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > ANALYSIS_LIMITS.requestBytes) throw new Error('REQUEST_TOO_LARGE');
    const { name, args, rootHint } = JSON.parse(input);
    if (rootHint) setLastKnownProjectRoot(rootHint);
    const tool = findTool(name);
    if (!tool) throw new Error(`UNKNOWN_TOOL: ${name}`);
    response = await tool.handler(args);
  } catch (err) {
    response = { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  } finally { closeAllDatabases(); }
  const output = JSON.stringify(response);
  if (Buffer.byteLength(output) > ANALYSIS_LIMITS.responseBytes) response = { isError: true, content: [{ type: 'text', text: 'RESPONSE_TOO_LARGE: maximum response is 8 MiB' }] };
  // Regular files also work where sandboxed Bun socket writes are denied.
  writeFileSync(process.argv[2], JSON.stringify(response), { mode: 0o600 });
}

if (import.meta.main) main().then(() => process.exit(0), err => { console.error(String(err)); process.exit(1); });
