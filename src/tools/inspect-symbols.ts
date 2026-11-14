import { createHash } from 'node:crypto';
import { sliceSymbol, formatSymbolSliceAsText } from '../engine/slicer';
import { extractComponentOutline, formatOutlineAsText } from '../engine/outline';
import { resolveWorkspacePath, findProjectRoot } from '../engine/path-resolver';
import { readSourceSnapshot, readSourceFile } from '../engine/source-file';
import { derivedRetrievalEvidence, formatRetrievalEvidence } from '../engine/retrieval-evidence';
import { loadAliasConfigWithDependencies } from '../engine/resolver';
import type { ToolCallResponse } from './types';

export async function inspectSymbols(args: Record<string, unknown>, filePath: string, targetPathHint?: string): Promise<ToolCallResponse | undefined> {
  const isJson = args.format === 'json';
  const isOutline = Boolean(args.outline || args.include_outline || args.outline_symbols);
  const symbolName = args.symbol;
  // Sub-action A0: Component Symbol Outline with line ranges & callee mappings
  if (isOutline) {
    const primary = await readSourceSnapshot(filePath);
    const outlineResult = await extractComponentOutline(filePath, {
      path: filePath,
    });

    let configFingerprint: string | undefined;
    try {
      const { configFiles } = await loadAliasConfigWithDependencies(filePath);
      if (configFiles.length > 0) {
        const ch = createHash('sha256');
        for (const cf of configFiles.sort()) {
          try {
            const cfContent = await readSourceFile(cf);
            ch.update(cf).update('\0').update(createHash('sha256').update(cfContent).digest('hex'));
          } catch {}
        }
        configFingerprint = ch.digest('hex');
      }
    } catch {}

    const retrieval = await derivedRetrievalEvidence({
      workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath),
      snapshot: primary.snapshot,
      policy: 'component-outline-v1',
      query: {},
      complete: false,
      selectionReason: 'Requested symbol outline and derived cross-file mappings; analyzer may read additional source versions.',
      dependencies: outlineResult.dependencies,
      configFingerprint,
    });
    return {
      structuredContent: { ...outlineResult, retrieval },
      content: [
        {
          type: 'text',
          text: isJson ? JSON.stringify({ ...outlineResult, retrieval }, null, 2) : `${formatOutlineAsText(outlineResult)}\n\n${formatRetrievalEvidence(retrieval)}`,
        },
      ],
    };
  }

  // Sub-action A: Symbol slicing
  if (symbolName) {
    const primary = await readSourceSnapshot(filePath);
    const result = await sliceSymbol({
      path: filePath,
      symbolName: String(symbolName),
      workspaceRoot: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath),
      includeBlastRadius: true,
    });
    const retrieval = await derivedRetrievalEvidence({ workspace: targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath), snapshot: primary.snapshot,
      policy: 'symbol-slice-v1', query: { symbolName: String(symbolName), includeBlastRadius: true }, complete: false,
      selectionReason: 'Requested named symbol and derived caller information; analyzer may read additional source versions.' });
    if (!result) {
      return {
        structuredContent: { file: filePath, found: false, symbol: String(symbolName), retrieval },
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify({ file: filePath, found: false, symbol: String(symbolName), retrieval }, null, 2) : `Symbol '${symbolName}' not found in '${filePath}'.\n${formatRetrievalEvidence(retrieval)}`,
          },
        ],
      };
    }
    const wantsStructured = isJson || Boolean(args.include_structured || args.includeStructured);
    const { code: _omittedCode, ...resultWithoutCode } = result;
    return {
      structuredContent: { ...(wantsStructured ? result : resultWithoutCode), retrieval },
      content: [
        {
          type: 'text',
          text: isJson ? JSON.stringify({ ...result, retrieval }, null, 2) : `${formatSymbolSliceAsText(result)}\n\n${formatRetrievalEvidence(retrieval)}`,
        },
      ],
    };
  }


}
