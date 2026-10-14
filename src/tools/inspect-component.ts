import { TOOL_CATALOG } from './catalog';
import fs from 'node:fs';
import { basename, extname, relative, isAbsolute, resolve } from 'node:path';
import { collectFiles } from '../engine/collector';
import { sliceSymbol, formatSymbolSliceAsText } from '../engine/slicer';
import {
  auditEventHandlers,
  formatEventHandlerAuditAsText,
  detectReactivitySmells,
  formatReactivitySmellsAsText,
} from '../engine/reactivity';
import { extractComponentContract, formatContractAsText } from '../engine/contract';
import { extractComponentOutline, formatOutlineAsText } from '../engine/outline';
import { resolveWorkspacePath, findProjectRoot, PROJECT_ROOT_MARKERS } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const inspectComponentTool: McpToolDefinition = {
  ...TOOL_CATALOG[1],
  handler: async (args: Record<string, any>) => {
    const rawTargetHint = args.root || args.project_root || args.target_path || args.targetPath;
    const targetPathHint = rawTargetHint && !/\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(String(rawTargetHint))
      ? String(rawTargetHint)
      : undefined;
    const rawPath = (args.path || args.file_path || args.filePath || args.target_path || args.targetPath || args.component || args.component_path)
      ? String(args.path || args.file_path || args.filePath || args.target_path || args.targetPath || args.component || args.component_path)
      : (targetPathHint || '');

    if (!rawPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: "Missing required argument: 'path' (or 'file_path', 'target_path')" }],
      };
    }

    const filePath = resolveWorkspacePath(rawPath, targetPathHint);

    if (!fs.existsSync(filePath)) {
      const root = targetPathHint ? resolveWorkspacePath(targetPathHint) : findProjectRoot(filePath);
      const rel = relative(root, filePath);
      let suggestions: string[] = [];
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') &&
          (targetPathHint || PROJECT_ROOT_MARKERS.some(marker => fs.existsSync(resolve(root, marker))))) {
        try {
          const stem = basename(filePath, extname(filePath));
          suggestions = (await collectFiles(root))
            .filter(candidate => basename(candidate, extname(candidate)) === stem)
            .sort().slice(0, 5);
        } catch {
          // Suggestions are optional; retain the original not-found diagnostic.
        }
      }
      const error = `Component file not found: ${filePath}`;
      const isJson = args.output_format === 'json' || args.format === 'json';
      return {
        isError: true,
        content: [{ type: 'text', text: isJson
          ? JSON.stringify({ error, requestedPath: filePath, suggestions }, null, 2)
          : error + (suggestions.length ? '\nCandidate paths (retry with the intended path):\n' + suggestions.join('\n') : '') }],
      };
    }

    try {
      if (fs.statSync(filePath).isDirectory()) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Target path '${filePath}' is a directory. 'inspect_component' requires a component file (e.g. .vue, .tsx, .jsx, .astro). Use 'audit_frontend' or 'get_component_tree' to inspect directories.`,
            },
          ],
        };
      }
    } catch {}

    const isJson = args.output_format === 'json' || args.format === 'json';
    const symbolName = args.symbol || args.symbol_name;
    const isOutline = Boolean(args.outline || args.include_outline || args.outline_symbols);

    try {
      // Sub-action A0: Component Symbol Outline with line ranges & callee mappings
      if (isOutline) {
        const outlineResult = await extractComponentOutline(filePath, {
          path: filePath,
          maxFunctionLines: args.max_function_lines ? Number(args.max_function_lines) : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(outlineResult, null, 2) : formatOutlineAsText(outlineResult),
            },
          ],
        };
      }

      // Sub-action A: Symbol slicing
      if (symbolName) {
        const result = await sliceSymbol({
          path: filePath,
          symbolName: String(symbolName),
          includeBlastRadius: true,
        });
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol '${symbolName}' not found in '${filePath}'.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: isJson ? JSON.stringify(result, null, 2) : formatSymbolSliceAsText(result),
            },
          ],
        };
      }

      // Sub-action B: Public interface contract with reactivity smells & optional event handler audit
      const inferProps = args.infer_props !== false && args.inferProps !== false;
      const resolveGlobals = args.resolve_globals !== false && args.resolveGlobals !== false;
      const auditEvents = Boolean(args.audit_events || args.auditEvents);
      const contract = await extractComponentContract(filePath, { inferProps, resolveGlobals });

      // Detect Reactivity Smells directly as first-class diagnostics
      const reactivitySmells = await detectReactivitySmells({ path: filePath });
      contract.reactivitySmells = reactivitySmells;

      if (auditEvents) {
        const auditResult = await auditEventHandlers({ path: filePath });
        if (isJson) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ...contract,
                    eventAudit: auditResult,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const contractText = formatContractAsText(contract);
        const auditText = formatEventHandlerAuditAsText(auditResult);
        return {
          content: [
            {
              type: 'text',
              text: `${contractText}\n\n${auditText}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(contract, null, 2) : formatContractAsText(contract),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to inspect component "${filePath}": ${msg}` }],
      };
    }
  },
};

