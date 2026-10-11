import fs from 'node:fs';
import { sliceSymbol, formatSymbolSliceAsText } from '../engine/slicer';
import {
  auditEventHandlers,
  formatEventHandlerAuditAsText,
  detectReactivitySmells,
  formatReactivitySmellsAsText,
} from '../engine/reactivity';
import { extractComponentContract, formatContractAsText } from '../engine/contract';
import { resolveWorkspacePath } from '../engine/path-resolver';
import type { McpToolDefinition } from './types';

export const inspectComponentTool: McpToolDefinition = {
  name: 'inspect_component',
  description:
    'Deep component inspection (.vue, .tsx, .jsx, .astro). Extracts interface contracts (props/emits/slots), layout structure & dynamic classes (:class, Tailwind layout tokens, v-show/v-if), data fetching boundaries (Inertia, TanStack Query, Axios endpoints & backend target hints), form schemas, and reactivity smells.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target component or file path (e.g. "src/components/MyButton.vue", alias: file_path, target_path)',
      },
      symbol: {
        type: 'string',
        description:
          'Symbol/function name to slice verbatim with exact line numbers, callers, and covering test detection (e.g. "calculateTotal", "handleSubmit", alias: symbol_name)',
      },
      audit_events: {
        type: 'boolean',
        description:
          'When true on Vue components, audits template-to-script reactivity integrity for broken and dead event handlers',
      },
      infer_props: {
        type: 'boolean',
        description:
          'When true (default), deeply infers object prop sub-properties (.data, .links, etc.) and data shapes from template and script AST',
      },
      resolve_globals: {
        type: 'boolean',
        description:
          'When true (default), identifies un-imported global symbols, Ziggy route() helpers, and auto-imported composables',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text", alias: output_format)',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    const targetPathHint = (args.target_path || args.targetPath || args.project_root || args.root)
      ? String(args.target_path || args.targetPath || args.project_root || args.root)
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
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Component file not found: ${filePath}`,
          },
        ],
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

    try {
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

