import { sliceSymbol, formatSymbolSliceAsText } from '../engine/slicer';
import { auditEventHandlers, formatEventHandlerAuditAsText } from '../engine/reactivity';
import { extractComponentContract, formatContractAsText } from '../engine/contract';
import type { McpToolDefinition } from './types';

export const inspectComponentTool: McpToolDefinition = {
  name: 'inspect_component',
  description:
    'Deep inspection of a specific frontend component or file (.vue, .tsx, .jsx, .astro, .ts, .js). Extracts public interface contracts (props/emits/slots), slices specific function/symbol bodies with exact line numbers, callers, and covering test suites (blast radius), or audits Vue SFC template-to-script event handlers for broken/dead bindings. Use this before modifying or refactoring a function to safely assess impact without dumping the full file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target component or file path (alias: target_path)',
      },
      target_path: {
        type: 'string',
        description: 'Alias for path',
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
      output_format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format: text or json (default: "text")',
      },
    },
    required: ['path'],
  },
  handler: async (args: Record<string, any>) => {
    const filePath = (args.path || args.target_path) ? String(args.path || args.target_path) : '';
    if (!filePath) {
      return {
        isError: true,
        content: [{ type: 'text', text: "Missing required argument: 'path' (or 'target_path')" }],
      };
    }

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

    // Sub-action B: Event handler reactivity audit
    if (args.audit_events) {
      const result = await auditEventHandlers({ path: filePath });
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(result, null, 2) : formatEventHandlerAuditAsText(result),
          },
        ],
      };
    }

    // Sub-action C: Default public interface contract
    const contract = await extractComponentContract(filePath);
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
