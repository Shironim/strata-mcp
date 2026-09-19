import { basename, extname } from 'node:path';
import ts from 'typescript';
import { executeAstGrep, isBinaryExecutionError } from '../astgrep';
import { extractPropertySignatures } from './contract-vue';
import { extractStyleTokens } from '../contract';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ContractOptions,
} from '../../types';

const REACT_EVENT_HANDLER_PATTERN = /^on[A-Z]/;


/** Reports whether a React prop name is an event callback (`onXxx`). */
function isReactEventHandler(propName: string): boolean {
  return REACT_EVENT_HANDLER_PATTERN.test(propName);
}

export async function extractReactContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  const slots: string[] = [];

  // 1. Search for Props interface or type
  // Pattern candidate names: [Component]Props, Props
  try {
    const ifaceMatches = await executeAstGrep({
      code: content,
      rule: `
id: react-props-iface
language: tsx
rule:
  any:
    - kind: interface_declaration
      has:
        field: name
        regex: '(?:Props|${component}Props)$'
    - kind: type_alias_declaration
      has:
        field: name
        regex: '(?:Props|${component}Props)$'
`,
      language: 'tsx',
    });

    if (ifaceMatches.length > 0) {
      const extracted = await extractPropertySignatures(ifaceMatches[0].text, 'tsx');
      for (const p of extracted) {
        if (p.name === 'children') {
          slots.push('default');
          continue;
        }

        // In React, props starting with 'on' followed by uppercase letter are event callbacks
        if (isReactEventHandler(p.name)) {
          emits.push({
            name: p.name,
            payload: p.type,
          });
        }

        props.push(p);
      }
    }
  } catch {
    // ignore
  }

  // If no slots found yet, check if children is referenced in JSX
  if (slots.length === 0 && (content.includes('{children}') || content.includes('props.children'))) {
    slots.push('default');
  }

  return {
    component,
    framework: 'react',
    filePath,
    props,
    emits,
    slots,
    styleTokens: extractStyleTokens(content),
  };
}

/**
 * Extracts Astro component contract from .astro source code.
 */
