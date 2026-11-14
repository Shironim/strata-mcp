import { parseStringFlag } from './arguments';
import { normalizeToolRequest, selectInspectOperation } from '../tools/request';
import { inspectComponentTool } from '../tools/inspect-component';
import { auditEventHandlers, formatEventHandlerAuditAsText } from '../engine/reactivity';
import { parseSafePositiveInt } from '../engine/path-resolver';
import { withAnalysisContext } from '../engine/analysis-context';

export function inspectFromCli(filePath: string, flags: Record<string, string | boolean>, isJson: boolean): Promise<void> {
  return withAnalysisContext(async () => {
    const view = parseStringFlag(flags.view);
    const rawRef = parseStringFlag(flags['source-ref'] ?? flags.sourceRef);
    let sourceRef: unknown;
    if (rawRef) {
      try { sourceRef = JSON.parse(rawRef); }
      catch { throw new Error(`Invalid JSON for --source-ref: "${rawRef}".`); }
    }
    if (view === 'source' && !sourceRef) throw new Error('--view source requires --source-ref <json> returned by --view map.');
    const rawRange = parseStringFlag(flags['source-range'] ?? flags.sourceRange);
    const range = rawRange?.match(/^(\d+):(\d+)$/);
    if (rawRange && !range) throw new Error('--source-range must use <start:end> inclusive line numbers');
    const args = normalizeToolRequest('inspect_component', {
      path: filePath, view, source_ref: sourceRef,
      ...(range ? { source_range: { start_line: Number(range[1]), end_line: Number(range[2]) } } : {}),
      expected_hash: parseStringFlag(flags['expected-hash'] ?? flags.expectedHash),
      symbol: parseStringFlag(flags.symbol ?? flags['symbol-name']), outline: Boolean(flags.outline),
      audit_events: Boolean(flags['audit-events']), impact: parseStringFlag(flags.impact),
      max_regions: parseSafePositiveInt(flags.limit, 200), format: isJson ? 'json' : 'text',
      // CLI inspection historically returns the complete result unless a budget is explicitly requested.
      max_bytes: flags['max-bytes'] === undefined ? Number.MAX_SAFE_INTEGER : Number(flags['max-bytes']),
    });
    const { operation } = selectInspectOperation(args);
    if (operation === 'audit_events') {
      const audit = await auditEventHandlers({ path: filePath });
      console.log(isJson ? JSON.stringify(audit, null, 2) : formatEventHandlerAuditAsText(audit));
      return;
    }
    const result = await inspectComponentTool.handler(args);
    if (result.isError) throw new Error(result.content[0]?.text ?? 'Inspection failed');
    if (result.structuredContent?.found === false) throw new Error(`Symbol "${args.symbol}" not found in "${filePath}".`);
    const data = result.structuredContent;
    if (!isJson && data?.clamped) process.stderr.write(`[strata] Note: end_line ${data.requestedEndLine} clamped to EOF (L${data.endLine}).\n`);
    const { retrieval: _retrieval, decision: _decision, ...primary } = data ?? {};
    console.log(isJson ? JSON.stringify(primary, null, 2) : result.content[0]?.text ?? '');
  });
}
