import { promises as fs } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentPropContract,
  ContractOptions,
} from '../types';

/**
 * Detects the component framework based on file extension.
 */
export function detectFramework(filePath: string): 'vue' | 'react' | 'astro' | 'unknown' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.vue') return 'vue';
  if (ext === '.astro') return 'astro';
  if (ext === '.tsx' || ext === '.jsx' || ext === '.ts' || ext === '.js') return 'react';
  return 'unknown';
}

/**
 * Extracts slot names from a template string using Vue compiler-dom.
 */
export function extractSlotsFromTemplate(templateContent: string): string[] {
  if (!templateContent.trim()) return [];

  try {
    const ast = parseDom(templateContent);
    const slots = new Set<string>();

    function walk(node: any) {
      if (!node) return;

      if (node.type === NodeTypes.ELEMENT && node.tag === 'slot') {
        let slotName = 'default';
        if (node.props) {
          for (const prop of node.props) {
            if (prop.type === 6 && prop.name === 'name' && prop.value?.content) {
              slotName = prop.value.content;
            } else if (
              prop.type === 7 &&
              prop.name === 'bind' &&
              prop.arg?.content === 'name' &&
              prop.exp?.content
            ) {
              slotName = prop.exp.content.replace(/['"]/g, '');
            }
          }
        }
        slots.add(slotName);
      }

      if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
          walk(child);
        }
      }
    }

    walk(ast);
    return Array.from(slots);
  } catch {
    // Non-fatal fallback for non-standard HTML / Astro islands
    const matches = templateContent.matchAll(/<slot(?:\s+name=['"]([^'"]+)['"])?[^>]*\/?>/gi);
    const slots = new Set<string>();
    for (const m of matches) {
      slots.add(m[1] || 'default');
    }
    return Array.from(slots);
  }
}

/**
 * Parses default values dictionary from a withDefaults object literal code string.
 */
function parseDefaultsObject(objectCode: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  const cleaned = objectCode.trim();
  const inner = cleaned.startsWith('{') && cleaned.endsWith('}') ? cleaned.slice(1, -1) : cleaned;

  // Match key: value pairs
  const lines = inner.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z0-9_$]+)\s*:\s*(.+?),?$/);
    if (match && match[1] && match[2]) {
      defaults[match[1]] = match[2].trim();
    }
  }

  return defaults;
}

/**
 * Extracts property signatures (name, required, type) from a TypeScript interface or type snippet.
 */
async function extractPropertySignatures(
  snippet: string,
  lang: string = 'ts'
): Promise<ComponentPropContract[]> {
  const props: ComponentPropContract[] = [];

  try {
    const rawMatches = await executeAstGrep({
      code: snippet,
      rule: `
id: extract-props
language: ${lang}
rule:
  kind: property_signature
`,
      language: lang,
    });

    for (const m of rawMatches) {
      const text = m.text.trim();
      const match = text.match(/^([A-Za-z0-9_$]+)(\?)?:\s*(.+)$/);
      if (match && match[1]) {
        const name = match[1];
        const isOptional = match[2] === '?';
        const type = match[3].replace(/;$/, '').trim();

        if (!props.some((p) => p.name === name)) {
          props.push({
            name,
            type,
            required: !isOptional,
          });
        }
      }
    }
  } catch (err) {
    if (isBinaryExecutionError(err)) throw err;
    // Non-fatal fallback
  }

  return props;
}

/**
 * Extracts Vue component contract from .vue source code.
 */
async function extractVueContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const descriptor = parseSfc(content, filePath);

  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  let slots: string[] = [];
  const exposed: string[] = [];

  // 1. Template slots
  if (descriptor.template) {
    slots = extractSlotsFromTemplate(descriptor.template.content);
  }

  // Combine script setup and regular script
  const scriptBlocks = [descriptor.scriptSetup, descriptor.script].filter(Boolean);
  const fullScript = scriptBlocks.map((b) => b!.content).join('\n\n');
  const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang || 'ts';

  if (fullScript) {
    // 2. Props Extraction
    let defaultsMap: Record<string, string> = {};

    // A. Check for withDefaults(defineProps<...>, { ... })
    try {
      const withDefaultsMatches = await executeAstGrep({
        code: fullScript,
        pattern: 'withDefaults(defineProps<$$$>(), { $$$ })',
        language: lang,
      });

      for (const m of withDefaultsMatches) {
        const text = m.text;
        const secondArgMatch = text.match(/withDefaults\s*\([^,]+,\s*(\{[\s\S]*?\})\s*\)/);
        if (secondArgMatch && secondArgMatch[1]) {
          defaultsMap = parseDefaultsObject(secondArgMatch[1]);
        }
      }
    } catch {
      // ignore
    }

    // B. Type-based defineProps<{ ... }>()
    try {
      const typePropsMatches = await executeAstGrep({
        code: fullScript,
        pattern: 'defineProps<$$$>()',
        language: lang,
      });

      for (const m of typePropsMatches) {
        const snippet = m.text;
        // Check if inline object type or named interface: defineProps<Props>()
        const namedMatch = snippet.match(/defineProps<([A-Za-z0-9_$]+)>\(\)/);
        if (namedMatch && namedMatch[1]) {
          const typeName = namedMatch[1];
          // Search for interface or type definition
          const ifaceMatches = await executeAstGrep({
            code: fullScript,
            pattern: `interface ${typeName} { $$$ }`,
            language: lang,
          });
          if (ifaceMatches.length > 0) {
            const extracted = await extractPropertySignatures(ifaceMatches[0].text, lang);
            props.push(...extracted);
          } else {
            const typeAliasMatches = await executeAstGrep({
              code: fullScript,
              pattern: `type ${typeName} = { $$$ }`,
              language: lang,
            });
            if (typeAliasMatches.length > 0) {
              const extracted = await extractPropertySignatures(typeAliasMatches[0].text, lang);
              props.push(...extracted);
            }
          }
        } else {
          // Inline object type
          const extracted = await extractPropertySignatures(snippet, lang);
          props.push(...extracted);
        }
      }
    } catch {
      // ignore
    }

    // C. Runtime defineProps({ ... })
    if (props.length === 0) {
      try {
        const runtimeMatches = await executeAstGrep({
          code: fullScript,
          pattern: 'defineProps({ $$$ })',
          language: lang,
        });

        for (const m of runtimeMatches) {
          const pairs = await executeAstGrep({
            code: m.text,
            rule: `
id: runtime-pair
language: ${lang}
rule:
  kind: pair
  inside:
    pattern: defineProps({ $$$ })
`,
            language: lang,
          });

          for (const p of pairs) {
            const keyMatch = p.text.match(/^([A-Za-z0-9_$]+)\s*:\s*(.+)$/s);
            if (keyMatch && keyMatch[1]) {
              const name = keyMatch[1];
              const val = keyMatch[2];
              const isRequired = /required\s*:\s*true/.test(val);
              const typeMatch = val.match(/type\s*:\s*([A-Za-z0-9_$]+)/);
              const defaultMatch = val.match(/default\s*:\s*([^,\n}]+)/);

              props.push({
                name,
                type: typeMatch ? typeMatch[1] : 'any',
                required: isRequired,
                default: defaultMatch ? defaultMatch[1].trim() : undefined,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Apply defaults from withDefaults
    for (const p of props) {
      if (defaultsMap[p.name]) {
        p.default = defaultsMap[p.name];
      }
    }

    // 3. Emits Extraction
    // A. Type-based defineEmits<{ ... }>() with call signatures
    try {
      const typeEmitsMatches = await executeAstGrep({
        code: fullScript,
        pattern: 'defineEmits<$$$>()',
        language: lang,
      });

      for (const m of typeEmitsMatches) {
        const callSigMatches = await executeAstGrep({
          code: m.text,
          rule: `
id: emit-call-sig
language: ${lang}
rule:
  kind: call_signature
`,
          language: lang,
        });

        for (const cs of callSigMatches) {
          const text = cs.text.trim();
          const match = text.match(/\(\s*(?:e\s*:\s*)?['"]([^'"]+)['"](?:\s*,\s*(.+?))?\s*\)/);
          if (match && match[1]) {
            emits.push({
              name: match[1],
              payload: match[2] ? match[2].trim() : undefined,
            });
          }
        }

        // Check for Vue 3.3+ tuple syntax: { 'view-details': [product: Product] }
        if (emits.length === 0) {
          const propSigs = await extractPropertySignatures(m.text, lang);
          for (const ps of propSigs) {
            emits.push({
              name: ps.name.replace(/['"]/g, ''),
              payload: ps.type,
            });
          }
        }
      }
    } catch {
      // ignore
    }

    // B. Array-based defineEmits(['close', 'view-details'])
    if (emits.length === 0) {
      try {
        const arrayEmitsMatches = await executeAstGrep({
          code: fullScript,
          pattern: 'defineEmits([$$$])',
          language: lang,
        });

        for (const m of arrayEmitsMatches) {
          const names = m.text.matchAll(/['"]([^'"]+)['"]/g);
          for (const n of names) {
            emits.push({ name: n[1] });
          }
        }
      } catch {
        // ignore
      }
    }

    // 4. Exposed Extraction
    try {
      const exposeMatches = await executeAstGrep({
        code: fullScript,
        pattern: 'defineExpose({ $$$ })',
        language: lang,
      });

      for (const m of exposeMatches) {
        const names = m.text.matchAll(/([A-Za-z0-9_$]+)\s*[,}]/g);
        for (const n of names) {
          if (n[1] !== 'defineExpose') {
            exposed.push(n[1]);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    component,
    framework: 'vue',
    filePath,
    props,
    emits,
    slots,
    exposed: exposed.length > 0 ? Array.from(new Set(exposed)) : undefined,
  };
}

/**
 * Extracts React component contract from .tsx / .jsx / .ts source code.
 */
async function extractReactContract(filePath: string, content: string): Promise<ComponentContract> {
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
        if (/^on[A-Z]/.test(p.name)) {
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
  };
}

/**
 * Extracts Astro component contract from .astro source code.
 */
async function extractAstroContract(filePath: string, content: string): Promise<ComponentContract> {
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

/**
 * Public facade: extracts the public contract of a component (.vue, .tsx, .jsx, .astro).
 */
export async function extractComponentContract(
  filePath: string,
  explicitContent?: string
): Promise<ComponentContract> {
  const resolvedPath = resolve(filePath);
  const content = explicitContent !== undefined ? explicitContent : await fs.readFile(resolvedPath, 'utf8');
  const framework = detectFramework(resolvedPath);

  switch (framework) {
    case 'vue':
      return extractVueContract(resolvedPath, content);
    case 'react':
      return extractReactContract(resolvedPath, content);
    case 'astro':
      return extractAstroContract(resolvedPath, content);
    default: {
      const component = basename(resolvedPath, extname(resolvedPath));
      return {
        component,
        framework: 'unknown',
        filePath: resolvedPath,
        props: [],
        emits: [],
        slots: [],
      };
    }
  }
}

/**
 * Formats a ComponentContract into a token-efficient, human-readable text summary.
 */
export function formatContractAsText(contract: ComponentContract): string {
  const lines: string[] = [
    `Component: ${contract.component} (${contract.framework})`,
    `File: ${contract.filePath}`,
  ];

  lines.push('');
  lines.push('Props:');
  if (contract.props.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of contract.props) {
      const reqStr = p.required ? 'required' : 'optional';
      const defStr = p.default ? `, default: ${p.default}` : '';
      lines.push(`  - ${p.name}: ${p.type} (${reqStr}${defStr})`);
    }
  }

  lines.push('');
  lines.push('Emits:');
  if (contract.emits.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of contract.emits) {
      const payloadStr = e.payload ? `(payload: ${e.payload})` : '';
      lines.push(`  - ${e.name}${payloadStr}`);
    }
  }

  lines.push('');
  lines.push('Slots:');
  if (contract.slots.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of contract.slots) {
      lines.push(`  - ${s}`);
    }
  }

  if (contract.exposed && contract.exposed.length > 0) {
    lines.push('');
    lines.push('Exposed:');
    for (const exp of contract.exposed) {
      lines.push(`  - ${exp}`);
    }
  }

  return lines.join('\n');
}
