import { readFileSync, writeFileSync } from 'node:fs';
import { findTool } from './tools';
import { closeAllDatabases } from './engine/storage/schema';
import { getLastKnownProjectRoot, setLastKnownProjectRoot } from './engine/path-resolver';
import { ANALYSIS_LIMITS } from './analysis-supervisor';
import type { ToolCallResponse } from './tools/types';

export async function runWorker(outputPath = process.argv[2]): Promise<void> {
  let response: ToolCallResponse;
  let detectedRoot: string | undefined;
  try {
    const input = readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > ANALYSIS_LIMITS.requestBytes) throw new Error('REQUEST_TOO_LARGE');
    const { name, args, rootHint } = JSON.parse(input);
    if (rootHint) setLastKnownProjectRoot(rootHint);
    const tool = findTool(name);
    if (!tool) throw new Error(`UNKNOWN_TOOL: ${name}`);
    response = await tool.handler(args);
    if (!response.isError) {
      detectedRoot = getLastKnownProjectRoot();
    }
  } catch (err) {
    response = { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  } finally { closeAllDatabases(); }
  const payload = {
    ...response,
    ...(detectedRoot ? { projectRoot: detectedRoot } : {}),
  };
  const output = JSON.stringify(payload);
  if (Buffer.byteLength(output) > ANALYSIS_LIMITS.responseBytes) {
    response = { isError: true, content: [{ type: 'text', text: 'RESPONSE_TOO_LARGE: maximum response is 8 MiB' }] };
    writeFileSync(outputPath, JSON.stringify(response), { mode: 0o600 });
    return;
  }
  // Regular files also work where sandboxed Bun socket writes are denied.
  writeFileSync(outputPath, output, { mode: 0o600 });
}

if (import.meta.main) runWorker().then(() => process.exit(0), err => { console.error(String(err)); process.exit(1); });
