import { basename, extname } from 'node:path';
import ts from 'typescript';
import { executeAstGrep, isBinaryExecutionError } from '../astgrep';
import { parseAstro } from '../astro-sfc';
import { extractSlotsFromTemplate, extractPropertySignatures } from './contract-vue';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ContractOptions,
} from '../../types';

export async function extractAstroContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const descriptor = parseAstro(content, filePath);
  const props: ComponentPropContract[] = [];
  let slots: string[] = [];

  // 1. Slots from template
  if (descriptor.template) {
    slots = extractSlotsFromTemplate(descriptor.template.content);
  }

  // 2. Props from frontmatter
  if (descriptor.frontmatter) {
    try {
      const ifaceMatches = await executeAstGrep({
        code: descriptor.frontmatter.content,
        rule: `
id: astro-props
language: ts
rule:
  any:
    - kind: interface_declaration
      has:
        field: name
        regex: 'Props$'
    - kind: type_alias_declaration
      has:
        field: name
        regex: 'Props$'
`,
        language: 'ts',
      });

      if (ifaceMatches.length > 0) {
        const extracted = await extractPropertySignatures(ifaceMatches[0].text, 'ts');
        props.push(...extracted);
      }
    } catch {
      // ignore
    }
  }

  return {
    component,
    framework: 'astro',
    filePath,
    props,
    emits: [],
    slots,
  };
}
