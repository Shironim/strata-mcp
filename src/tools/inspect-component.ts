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
    'Deep component inspection (.vue, .tsx, .jsx, .astro). Extracts interface contracts (props/emits/slots), data fetching boundaries (Inertia, TanStack Query, Axios endpoints & payload keys), form schemas & file uploads, reactivity smells (props destructuring, direct mutations), and slices symbols with blast radius.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target component or file path (alias: target_path)',
      },
      target_path: {
        type: 'string',
        description: 'Project root directory or alias for path',
      },
      symbol: {
        type: 'string',
        description:
          'Symbol/function name to slice verbatim with exact line numbers, callers, and covering test detection (e.g. "calculateTotal", "handleSubmit")',
      },
      symbol_name: {
        type: 'string',
        description: 'Alias for symbol',
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
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text")',
      },
    },
    required: ['path'],
  },
  handler: async (args: Record<string, any>) => {
    const targetPathHint = (args.target_path || args.project_root || args.root)
      ? String(args.target_path || args.project_root || args.root)
      : undefined;
    const rawPath = args.path
      ? String(args.path)
      : (targetPathHint || '');

    if (!rawPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: "Missing required argument: 'path' (or 'target_path')" }],
      };
    }

    const filePath = resolveWorkspacePath(rawPath, targetPathHint);

    const isJson = args.output_format === 'json';
    const symbolName = args.symbol || args.symbol_name;

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
    const inferProps = args.infer_props !== false;
    const resolveGlobals = args.resolve_globals !== false;
    const contract = await extractComponentContract(filePath, { inferProps, resolveGlobals });

    // Detect Reactivity Smells directly as first-class diagnostics
    const reactivitySmells = await detectReactivitySmells({ path: filePath });
    contract.reactivitySmells = reactivitySmells;

    if (args.audit_events) {
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
  },
};

