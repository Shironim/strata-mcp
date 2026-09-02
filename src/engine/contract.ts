import { promises as fs } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parse as parseDom, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import { stripQuotes } from './patterns';
import type {
  BoundaryViolation,
  ComponentContract,
  ComponentEmitContract,
  ComponentPropContract,
  ComponentVariantsInfo,
  ContractOptions,
  DataDependencyInfo,
  RenderBoundaryInfo,
  StateDependencyInfo,
} from '../types';

const SLOT_TAG_PATTERN = /<slot(?:\s+name=['"]([^'"]+)['"])?[^>]*\/?>/gi;
const DEFAULT_ENTRY_PATTERN = /^([A-Za-z0-9_$]+)\s*:\s*(.+?),?$/;
const PROP_NAME_VALUE_PATTERN = /^([A-Za-z0-9_$]+)\s*:\s*([\s\S]+)$/;
const REQUIRED_TRUE_PATTERN = /(?:^|[,\s])required\s*:\s*true/;
const TYPE_ANNOTATION_PATTERN = /type\s*:\s*([A-Za-z0-9_$]+)/;
const SHORTHAND_TYPE_PATTERN = /^[A-Za-z0-9_$]+$/;
const DEFAULT_VALUE_PATTERN = /default\s*:\s*([^,\n}]+)/;
const PROPERTY_SIGNATURE_PATTERN = /^([A-Za-z0-9_$]+)(\?)?:\s*(.+)$/;
const WITH_DEFAULTS_SECOND_ARG_PATTERN = /withDefaults\s*\([^,]+,\s*(\{[\s\S]*?\})\s*\)/;
const NAMED_PROPS_TYPE_PATTERN = /defineProps<([A-Za-z0-9_$]+)>\(\)/;
const EMIT_CALL_SIGNATURE_PATTERN = /\(\s*(?:e\s*:\s*)?['"]([^'"]+)['"](?:\s*,\s*(.+?))?\s*\)/;
const QUOTED_STRING_PATTERN = /['"]([^'"]+)['"]/g;
const EXPOSED_NAME_PATTERN = /([A-Za-z0-9_$]+)\s*[,}]/g;
const REACT_EVENT_HANDLER_PATTERN = /^on[A-Z]/;

/** Reads the declared type of a runtime-JS prop value (`{ type: X }` or shorthand `X`). */
function extractPropType(propValue: string): string {
  const typeMatch = propValue.match(TYPE_ANNOTATION_PATTERN);
  if (typeMatch && typeMatch[1]) return typeMatch[1];
  return SHORTHAND_TYPE_PATTERN.test(propValue) ? propValue : 'any';
}

/** Reads the default value of a runtime-JS prop value (`{ default: 0 }`). */
function extractPropDefault(propValue: string): string | undefined {
  return propValue.match(DEFAULT_VALUE_PATTERN)?.[1]?.trim();
}

/** Reports whether a runtime-JS prop value declares `required: true`. */
function isPropRequired(propValue: string): boolean {
  return REQUIRED_TRUE_PATTERN.test(propValue);
}

/** Reports whether a React prop name is an event callback (`onXxx`). */
function isReactEventHandler(propName: string): boolean {
  return REACT_EVENT_HANDLER_PATTERN.test(propName);
}

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

    function walk(node: RootNode | TemplateChildNode): void {
      if (node.type === NodeTypes.ELEMENT && node.tag === 'slot') {
        let slotName = 'default';
        for (const prop of node.props) {
          if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'name' && prop.value?.content) {
            slotName = prop.value.content;
          } else if (
            prop.type === NodeTypes.DIRECTIVE &&
            prop.name === 'bind' &&
            prop.arg &&
            'content' in prop.arg &&
            prop.arg.content === 'name' &&
            prop.exp &&
            'content' in prop.exp
          ) {
            slotName = stripQuotes(prop.exp.content);
          }
        }
        slots.add(slotName);
      }

      if (
        node.type === NodeTypes.ROOT ||
        node.type === NodeTypes.ELEMENT ||
        node.type === NodeTypes.FOR
      ) {
        for (const child of node.children) {
          walk(child);
        }
      } else if (node.type === NodeTypes.IF) {
        for (const branch of node.branches) {
          for (const child of branch.children) {
            walk(child);
          }
        }
      }
    }

    walk(ast);
    return Array.from(slots);
  } catch {
    // Non-fatal fallback for non-standard HTML / Astro islands
    const matches = templateContent.matchAll(SLOT_TAG_PATTERN);
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
    const match = trimmed.match(DEFAULT_ENTRY_PATTERN);
    if (match && match[1] && match[2]) {
      defaults[match[1]] = match[2].trim();
    }
  }

  return defaults;
}

/**
 * Extracts the first function-call argument from a call expression text, if it is an object literal.
 * Example: `defineProps({ name: { type: String } })` -> `{ name: { type: String } }`.
 */
function extractObjectArgument(callText: string): string | null {
  const open = callText.indexOf('(');
  if (open === -1) return null;

  let depth = 0;
  let inString: string | null = null;

  for (let i = open; i < callText.length; i++) {
    const ch = callText[i];

    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth--;
      if (depth === 0) {
        const arg = callText.slice(open + 1, i).trim();
        return arg.startsWith('{') ? arg : null;
      }
    }
  }

  return null;
}

/**
 * Splits the inner text of an object literal into its top-level entries,
 * respecting nested `{}`, `[]`, `()`, and string literals.
 */
function splitTopLevelEntries(inner: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inString) {
      current += ch;
      if (ch === '\\') {
        current += inner[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      current += ch;
      continue;
    }

    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) entries.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) entries.push(trimmed);
  return entries;
}

/**
 * Parses a single top-level runtime prop entry such as:
 *   `name: { type: String, required: true, default: 'x' }`
 *   `title: String`
 */
function parseRuntimePropEntry(entry: string): ComponentPropContract | null {
  const match = entry.match(PROP_NAME_VALUE_PATTERN);
  if (!match || !match[1]) return null;

  const propValue = match[2].trim();

  // If propValue is an object literal, extract fields using balance-depth split
  if (propValue.startsWith('{') && propValue.endsWith('}')) {
    const inner = propValue.slice(1, -1);
    const fields = splitTopLevelEntries(inner);
    let type = 'any';
    let required = false;
    let defaultValue: string | undefined;

    for (const field of fields) {
      const fieldMatch = field.match(/^([A-Za-z0-9_$]+)\s*:\s*([\s\S]+)$/);
      if (!fieldMatch) continue;
      const key = fieldMatch[1];
      const val = fieldMatch[2].trim();

      if (key === 'type') {
        type = extractPropType(val);
      } else if (key === 'required') {
        required = val === 'true';
      } else if (key === 'default') {
        defaultValue = val;
      }
    }

    return {
      name: match[1],
      type,
      required,
      default: defaultValue,
    };
  }

  return {
    name: match[1],
    type: extractPropType(propValue),
    required: isPropRequired(propValue),
    default: extractPropDefault(propValue),
  };
}

/**
 * Parses a runtime-JS `defineProps({ ... })` object literal into prop contracts.
 * Handles nested `type`/`default`/`required` pairs without confusing them with props.
 */
export function parseRuntimePropsObject(objectText: string): ComponentPropContract[] {
  const cleaned = objectText.trim();
  const inner = cleaned.startsWith('{') && cleaned.endsWith('}') ? cleaned.slice(1, -1) : cleaned;
  const props: ComponentPropContract[] = [];

  for (const entry of splitTopLevelEntries(inner)) {
    const prop = parseRuntimePropEntry(entry);
    if (prop) props.push(prop);
  }

  return props;
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
      const match = text.match(PROPERTY_SIGNATURE_PATTERN);
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
        const secondArgMatch = text.match(WITH_DEFAULTS_SECOND_ARG_PATTERN);
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
        const namedMatch = snippet.match(NAMED_PROPS_TYPE_PATTERN);
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
          const objectArg = extractObjectArgument(m.text);
          if (!objectArg) continue;

          for (const p of parseRuntimePropsObject(objectArg)) {
            if (!props.some((existing) => existing.name === p.name)) {
              props.push(p);
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
          const match = text.match(EMIT_CALL_SIGNATURE_PATTERN);
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
              name: stripQuotes(ps.name),
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
          const names = m.text.matchAll(QUOTED_STRING_PATTERN);
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
        const names = m.text.matchAll(EXPOSED_NAME_PATTERN);
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
 * Detects isomorphic render boundary, SSR vs client hydration, and RSC directives.
 */
export function extractRenderBoundary(
  filePath: string,
  content: string,
  framework: 'vue' | 'react' | 'astro' | 'unknown'
): RenderBoundaryInfo {
  const normPath = filePath.replace(/\\/g, '/');
  const violations: BoundaryViolation[] = [];

  if (framework === 'react') {
    // 1. Check for 'use client' directive
    if (/^\s*['"]use client['"]/m.test(content)) {
      return {
        boundary: 'client-component',
        directive: 'use client',
        isClientHydrated: true,
      };
    }

    // 2. Check for 'use server' directive
    if (/^\s*['"]use server['"]/m.test(content)) {
      return {
        boundary: 'server-action',
        directive: 'use server',
        isClientHydrated: false,
      };
    }

    // 3. Next.js App router defaults to React Server Component (RSC)
    if (normPath.startsWith('app/') || normPath.includes('/app/')) {
      // Check for client-only hooks in RSC
      const clientHooks = Array.from(
        new Set(
          Array.from(
            content.matchAll(
              /\b(useState|useEffect|useReducer|useRef|useLayoutEffect|useTransition|useDeferredValue|useActionState|useOptimistic|createContext|useContext)\b/g
            )
          ).map((m) => m[1])
        )
      );

      if (clientHooks.length > 0) {
        violations.push({
          code: 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT',
          severity: 'error',
          message: `React Server Component uses client-only hook(s): ${clientHooks.join(', ')}.`,
          hint: "Add 'use client' directive at the top of the file to mark it as a Client Component.",
        });
      }

      // Check for DOM event handlers attached in JSX
      const eventHandlers = Array.from(
        new Set(
          Array.from(
            content.matchAll(
              /\b(onClick|onChange|onSubmit|onKeyDown|onKeyUp|onMouseEnter|onMouseLeave|onFocus|onBlur)\s*=/g
            )
          ).map((m) => m[1])
        )
      );

      if (eventHandlers.length > 0) {
        violations.push({
          code: 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT',
          severity: 'error',
          message: `React Server Component attaches client DOM event handler(s): ${eventHandlers.join(', ')}.`,
          hint: "Event handlers cannot be passed in Server Components. Add 'use client' or move the handler into a Client Component leaf.",
        });
      }

      return {
        boundary: 'server-component',
        isClientHydrated: false,
        violations: violations.length > 0 ? violations : undefined,
      };
    }

    // Standard client component in Vite/CRA/Next Pages router
    return {
      boundary: 'client-component',
      isClientHydrated: true,
    };
  }

  if (framework === 'vue') {
    if (normPath.endsWith('.client.vue')) {
      return {
        boundary: 'client-only',
        directive: '.client.vue',
        isClientHydrated: true,
      };
    }
    if (normPath.endsWith('.server.vue')) {
      return {
        boundary: 'server-only',
        directive: '.server.vue',
        isClientHydrated: false,
      };
    }
    if (/<ClientOnly\b/i.test(content)) {
      return {
        boundary: 'isomorphic',
        directive: '<ClientOnly>',
        isClientHydrated: true,
      };
    }

    return {
      boundary: 'isomorphic',
      isClientHydrated: true,
    };
  }

  if (framework === 'astro') {
    // Check if Astro component mounts any client-hydrated islands
    const islandMatch = content.match(/\b(client:(?:load|visible|idle|media|only)(?:=[^>\s]+)?)/i);
    if (islandMatch) {
      return {
        boundary: 'astro-island',
        directive: islandMatch[1],
        isClientHydrated: true,
      };
    }

    // Check for interactive components rendered in Astro without client directives
    const interactiveMatch = Array.from(
      new Set(
        Array.from(
          content.matchAll(
            /<([A-Z][A-Za-z0-9_$]*(?:Modal|Dialog|Dropdown|Drawer|Menu|Select|Button|Tabs|Form|Input|Counter|Carousel|Accordion))\b(?![^>]*\bclient:)/g
          )
        ).map((m) => m[1])
      )
    );

    if (interactiveMatch.length > 0 && !content.includes('client:')) {
      violations.push({
        code: 'ASTRO_UNHYDRATED_INTERACTIVE_ISLAND',
        severity: 'warning',
        message: `Interactive component(s) (${interactiveMatch.slice(0, 3).join(', ')}) rendered without hydration directive.`,
        hint: "Add client:load or client:visible if this component requires client-side interactivity, otherwise it will render as inert static HTML.",
      });
    }

    return {
      boundary: 'astro-static',
      isClientHydrated: false,
      violations: violations.length > 0 ? violations : undefined,
    };
  }

  return {
    boundary: 'unknown',
    isClientHydrated: false,
  };
}

const COMMON_HOOKS_IGNORE = new Set([
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'useRef',
  'useId',
  'useContext',
  'useReducer',
  'useTransition',
  'useDeferredValue',
  'useImperativeHandle',
  'useLayoutEffect',
  'useInsertionEffect',
  'useSyncExternalStore',
  'useSlots',
  'useAttrs',
  'useModel',
]);

/**
 * Extracts a balanced curly-brace object string starting at the specified index or first '{' after it.
 */
function extractBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  let started = false;
  let startPos = -1;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') {
      if (!started) {
        started = true;
        startPos = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        return text.slice(startPos, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts top-level keys from an object literal code snippet while ignoring string literals and nested values.
 */
function extractObjectKeys(objCode: string): string[] {
  const keys: string[] = [];
  const inner = objCode.trim().slice(1, -1);
  let inString: string | null = null;
  let currentKey = '';
  let collectingKey = true;
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      continue;
    }

    if (depth === 0) {
      if (ch === ':') {
        const trimmed = stripQuotes(currentKey.trim());
        if (trimmed && !trimmed.includes('\n') && !trimmed.includes(' ')) {
          keys.push(trimmed);
        }
        collectingKey = false;
        currentKey = '';
      } else if (ch === ',') {
        collectingKey = true;
        currentKey = '';
      } else if (collectingKey) {
        currentKey += ch;
      }
    }
  }

  return keys;
}

/**
 * Extracts Design System variants defined via CVA (Class Variance Authority) or TypeScript prop unions.
 */
export function extractComponentVariants(
  content: string,
  props: ComponentPropContract[] = []
): ComponentVariantsInfo | undefined {
  // 1. Try CVA pattern: look for cva( ... )
  const cvaIndex = content.indexOf('cva(');
  if (cvaIndex !== -1) {
    const firstBrace = content.indexOf('{', cvaIndex);
    if (firstBrace !== -1) {
      const configObj = extractBalancedObject(content, firstBrace);
      if (configObj) {
        const variants: Record<string, string[]> = {};
        let defaultVariants: Record<string, string> | undefined;

        // Look for variants: { ... } inside configObj
        const variantsKeyword = configObj.match(/\bvariants\s*:\s*\{/);
        if (variantsKeyword && variantsKeyword.index !== undefined) {
          const variantsBrace = configObj.indexOf('{', variantsKeyword.index);
          const variantsObj = extractBalancedObject(configObj, variantsBrace);
          if (variantsObj) {
            // Match groupName: { ... }
            const groupHeaderRegex = /\b([A-Za-z0-9_$]+)\s*:\s*\{/g;
            for (const gm of variantsObj.matchAll(groupHeaderRegex)) {
              const groupName = gm[1];
              if (groupName === 'defaultVariants' || groupName === 'compoundVariants') continue;
              const groupBrace = variantsObj.indexOf('{', gm.index);
              const groupBody = extractBalancedObject(variantsObj, groupBrace);
              if (groupBody) {
                const optKeys = extractObjectKeys(groupBody);
                if (optKeys.length > 0) {
                  variants[groupName] = optKeys;
                }
              }
            }
          }
        }

        // Look for defaultVariants: { ... } inside configObj
        const defKeyword = configObj.match(/\bdefaultVariants\s*:\s*\{/);
        if (defKeyword && defKeyword.index !== undefined) {
          const defBrace = configObj.indexOf('{', defKeyword.index);
          const defObj = extractBalancedObject(configObj, defBrace);
          if (defObj) {
            const defMap: Record<string, string> = {};
            const defPairs = defObj
              .slice(1, -1)
              .matchAll(/([A-Za-z0-9_$]+)\s*:\s*['"]?([A-Za-z0-9_$-]+)['"]?/g);
            for (const dm of defPairs) {
              defMap[dm[1]] = stripQuotes(dm[2].trim());
            }
            if (Object.keys(defMap).length > 0) {
              defaultVariants = defMap;
            }
          }
        }

        if (Object.keys(variants).length > 0) {
          return { variants, defaultVariants };
        }
      }
    }
  }

  // 2. Fallback: inspect props with union string literals (e.g. variant: 'primary' | 'secondary' | 'outline')
  const unionVariants: Record<string, string[]> = {};
  for (const prop of props) {
    if (prop.name === 'variant' || prop.name === 'size' || prop.name === 'intent' || prop.name === 'color') {
      if (prop.type && prop.type.includes('|')) {
        const parts = prop.type
          .split('|')
          .map((p) => stripQuotes(p.trim()))
          .filter((p) => p && !['undefined', 'null', 'string', 'boolean', 'number', 'any'].includes(p));
        if (parts.length > 1) {
          unionVariants[prop.name] = parts;
        }
      }
    }
  }

  if (Object.keys(unionVariants).length > 0) {
    return { variants: unionVariants };
  }

  return undefined;
}

/**
 * Extracts out-of-band state and store dependencies (Pinia, Zustand, Redux, Context, inject).
 */
export function extractStateDependencies(
  content: string,
  _framework: 'vue' | 'react' | 'astro' | 'unknown'
): StateDependencyInfo {
  const stores = new Set<string>();
  const contexts = new Set<string>();
  const composables = new Set<string>();

  // 1. Stores: Pinia / Zustand / Redux
  const storeRegex = /\b(use[A-Za-z0-9_$]*Store)\b/g;
  for (const m of content.matchAll(storeRegex)) {
    stores.add(m[1]);
  }

  const reduxRegex = /\b(useSelector|useDispatch|useAppSelector|useAppDispatch)\b/g;
  for (const m of content.matchAll(reduxRegex)) {
    stores.add(m[1]);
  }

  // 2. React Context & Vue inject
  const contextRegex = /\buseContext\(\s*([A-Za-z0-9_$]+)\s*\)/g;
  for (const m of content.matchAll(contextRegex)) {
    contexts.add(m[1]);
  }

  const vueInjectRegex = /\binject(?:\s*<[^>]*>)?\(\s*['"]?([A-Za-z0-9_$-]+)['"]?/g;
  for (const m of content.matchAll(vueInjectRegex)) {
    if (m[1]) contexts.add(m[1]);
  }

  // 3. Custom Composables / Hooks (useXxx)
  const hookRegex = /\b(use[A-Z][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of content.matchAll(hookRegex)) {
    const hookName = m[1];
    if (!COMMON_HOOKS_IGNORE.has(hookName) && !stores.has(hookName) && hookName !== 'useContext') {
      composables.add(hookName);
    }
  }

  return {
    stores: Array.from(stores),
    contexts: Array.from(contexts),
    composables: Array.from(composables),
  };
}

/**
 * Extracts data lineage dependencies (Server Actions, TanStack Query keys, API endpoints, and mutations).
 */
export function extractDataDependencies(
  content: string,
  _framework: 'vue' | 'react' | 'astro' | 'unknown'
): DataDependencyInfo | undefined {
  const serverActions = new Set<string>();
  const queryKeys = new Set<string>();
  const endpoints = new Set<string>();
  const mutations = new Set<string>();

  // 1. Server Actions ('use server' functions or action imports)
  const inlineServerActionRegex = /async\s+function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*['"]use server['"]/g;
  for (const m of content.matchAll(inlineServerActionRegex)) {
    serverActions.add(m[1]);
  }

  const actionImportRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]*(?:actions|server|mutations)[^'"]*['"]/g;
  for (const m of content.matchAll(actionImportRegex)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    names.forEach((n) => serverActions.add(n));
  }

  const actionFunctionCallRegex = /\b([A-Za-z0-9_$]+Action)\s*\(/g;
  for (const m of content.matchAll(actionFunctionCallRegex)) {
    serverActions.add(m[1]);
  }

  // 2. TanStack Query / SWR / Vue Query
  const tanstackObjectRegex = /useQuery\s*\(\s*\{[\s\S]*?queryKey\s*:\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(tanstackObjectRegex)) {
    queryKeys.add(m[1].replace(/\s+/g, ' ').trim());
  }

  const tanstackArrayRegex = /useQuery\s*\(\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(tanstackArrayRegex)) {
    queryKeys.add(m[1].replace(/\s+/g, ' ').trim());
  }

  const swrRegex = /useSWR\s*(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(swrRegex)) {
    queryKeys.add(`"${m[1]}"`);
    if (m[1].startsWith('/') || m[1].startsWith('http')) {
      endpoints.add(m[1]);
    }
  }

  // 3. HTTP Endpoints ($fetch, fetch, axios, api)
  const fetchRegex = /(?:\$fetch|fetch|axios\.(?:get|post|put|delete|patch)|api\.(?:get|post|put|delete|patch))\s*(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of content.matchAll(fetchRegex)) {
    const url = m[1].trim();
    if (url && (url.startsWith('/') || url.startsWith('http') || url.startsWith('api/'))) {
      endpoints.add(url);
    }
  }

  const useAsyncDataRegex = /useAsyncData\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(useAsyncDataRegex)) {
    queryKeys.add(`"${m[1]}"`);
  }

  // 4. Inertia.js Form & Router Mutations
  const inertiaMutationRegex = /(?:form|router)\.(post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of content.matchAll(inertiaMutationRegex)) {
    const method = m[1].toUpperCase();
    const target = m[2].trim();
    mutations.add(`${method} ${target}`);
    if (target.startsWith('/') || target.startsWith('http')) {
      endpoints.add(target);
    }
  }

  const result: DataDependencyInfo = {};
  if (serverActions.size > 0) result.serverActions = Array.from(serverActions);
  if (queryKeys.size > 0) result.queryKeys = Array.from(queryKeys);
  if (endpoints.size > 0) result.endpoints = Array.from(endpoints);
  if (mutations.size > 0) result.mutations = Array.from(mutations);

  return Object.keys(result).length > 0 ? result : undefined;
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

  let baseContract: ComponentContract;
  switch (framework) {
    case 'vue':
      baseContract = await extractVueContract(resolvedPath, content);
      break;
    case 'react':
      baseContract = await extractReactContract(resolvedPath, content);
      break;
    case 'astro':
      baseContract = await extractAstroContract(resolvedPath, content);
      break;
    default: {
      const component = basename(resolvedPath, extname(resolvedPath));
      baseContract = {
        component,
        framework: 'unknown',
        filePath: resolvedPath,
        props: [],
        emits: [],
        slots: [],
      };
      break;
    }
  }

  const renderBoundary = extractRenderBoundary(resolvedPath, content, framework);
  const stateDependencies = extractStateDependencies(content, framework);
  const dataDependencies = extractDataDependencies(content, framework);
  const variants = extractComponentVariants(content, baseContract.props);

  return {
    ...baseContract,
    variants,
    renderBoundary,
    stateDependencies,
    dataDependencies,
  };
}

/**
 * Formats a ComponentContract into a token-efficient, human-readable text summary.
 */
export function formatContractAsText(contract: ComponentContract): string {
  const lines: string[] = [
    `Component: ${contract.component} (${contract.framework})`,
    `File: ${contract.filePath}`,
  ];

  if (contract.renderBoundary) {
    const directiveStr = contract.renderBoundary.directive
      ? ` ('${contract.renderBoundary.directive}')`
      : '';
    lines.push(`Render Boundary: ${contract.renderBoundary.boundary}${directiveStr}`);
  }

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

  if (contract.variants) {
    lines.push('');
    lines.push('Variants:');
    for (const [vName, vOptions] of Object.entries(contract.variants.variants)) {
      const defValue = contract.variants.defaultVariants?.[vName];
      const defStr = defValue ? ` (default: "${defValue}")` : '';
      lines.push(`  - ${vName}: [${vOptions.map((o) => `"${o}"`).join(', ')}]${defStr}`);
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

  if (contract.stateDependencies) {
    const { stores, contexts, composables } = contract.stateDependencies;
    if (stores.length > 0 || contexts.length > 0 || composables.length > 0) {
      lines.push('');
      lines.push('State Dependencies:');
      if (stores.length > 0) {
        lines.push(`  - Stores: ${stores.join(', ')}`);
      }
      if (contexts.length > 0) {
        lines.push(`  - Context/Injected: ${contexts.join(', ')}`);
      }
      if (composables.length > 0) {
        lines.push(`  - Composables: ${composables.join(', ')}`);
      }
    }
  }

  if (contract.dataDependencies) {
    const { serverActions, queryKeys, endpoints, mutations } = contract.dataDependencies;
    if (
      (serverActions && serverActions.length > 0) ||
      (queryKeys && queryKeys.length > 0) ||
      (endpoints && endpoints.length > 0) ||
      (mutations && mutations.length > 0)
    ) {
      lines.push('');
      lines.push('Data Lineage & Fetching:');
      if (serverActions && serverActions.length > 0) {
        lines.push(`  - Server Actions: ${serverActions.join(', ')}`);
      }
      if (queryKeys && queryKeys.length > 0) {
        lines.push(`  - Query Keys: ${queryKeys.join(', ')}`);
      }
      if (endpoints && endpoints.length > 0) {
        lines.push(`  - API Endpoints: ${endpoints.join(', ')}`);
      }
      if (mutations && mutations.length > 0) {
        lines.push(`  - Form Mutations: ${mutations.join(', ')}`);
      }
    }
  }

  if (contract.renderBoundary?.violations && contract.renderBoundary.violations.length > 0) {
    lines.push('');
    lines.push('Boundary Warnings / Violations:');
    for (const v of contract.renderBoundary.violations) {
      lines.push(`  - [${v.severity.toUpperCase()}] ${v.code}: ${v.message}`);
      if (v.hint) {
        lines.push(`    Hint: ${v.hint}`);
      }
    }
  }

  return lines.join('\n');
}
