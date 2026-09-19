import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { parse as parseDom, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import ts from 'typescript';
import { executeAstGrep, isBinaryExecutionError } from '../astgrep';
import { parseSfc } from '../splitter';
import { stripQuotes, escapeRegExp } from '../patterns';
import { extractStyleTokens } from '../contract';
import type {
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ComponentSlotDetail,
  ContractOptions,
} from '../../types';

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


/**
 * Extracts slot details (including scoped bindings) from a template string using Vue compiler-dom.
 */
export function extractSlotDetailsFromTemplate(templateContent: string): ComponentSlotDetail[] {
  if (!templateContent.trim()) return [];

  try {
    const ast = parseDom(templateContent);
    const slotMap = new Map<string, ComponentSlotDetail>();

    function walk(node: RootNode | TemplateChildNode): void {
      if (node.type === NodeTypes.ELEMENT && node.tag === 'slot') {
        let slotName = 'default';
        const bindings: string[] = [];
        const payload: Record<string, string> = {};

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
          } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg && 'content' in prop.arg) {
            const bName = prop.arg.content;
            bindings.push(bName);
            const expVal = prop.exp && 'content' in prop.exp ? prop.exp.content : '';
            payload[bName] = expVal;
          } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && !prop.arg && prop.exp && 'content' in prop.exp) {
            bindings.push('...v-bind');
            payload['...v-bind'] = prop.exp.content;
          } else if (prop.type === NodeTypes.ATTRIBUTE && prop.name !== 'name') {
            bindings.push(prop.name);
            payload[prop.name] = prop.value?.content || '';
          }
        }

        const existing = slotMap.get(slotName);
        if (!existing) {
          slotMap.set(slotName, {
            name: slotName,
            isScoped: bindings.length > 0,
            bindings: bindings.length > 0 ? bindings : undefined,
            payload: Object.keys(payload).length > 0 ? payload : undefined,
          });
        } else if (bindings.length > 0) {
          existing.isScoped = true;
          existing.bindings = Array.from(new Set([...(existing.bindings || []), ...bindings]));
          if (Object.keys(payload).length > 0) {
            existing.payload = { ...(existing.payload || {}), ...payload };
          }
        }
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
    return Array.from(slotMap.values());
  } catch {
    return [];
  }
}

/**
 * Extracts slot names from a template string using Vue compiler-dom.
 */
export function extractSlotsFromTemplate(templateContent: string): string[] {
  return extractSlotDetailsFromTemplate(templateContent).map((s) => s.name);
}

/**
 * Parses default values dictionary from a withDefaults object literal code string
 * using TypeScript Compiler API AST traversal for 100% precision on multiline objects/functions.
 */
function parseDefaultsObject(objectCode: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  const trimmed = objectCode.trim();
  if (!trimmed) return defaults;

  try {
    const wrappedCode = trimmed.startsWith('{') ? `const _d = ${trimmed}` : `const _d = { ${trimmed} }`;
    const sourceFile = ts.createSourceFile('defaults.ts', wrappedCode, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          if (ts.isPropertyAssignment(prop)) {
            let key = '';
            if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
              key = prop.name.text;
            } else {
              key = prop.name.getText(sourceFile);
            }
            const val = prop.initializer.getText(sourceFile).trim();
            if (key) {
              defaults[key] = val;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  } catch {
    // Fallback line-matching if AST creation fails
    const inner = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
    const lines = inner.split('\n');
    for (const line of lines) {
      const lineTrim = line.trim();
      const match = lineTrim.match(DEFAULT_ENTRY_PATTERN);
      if (match && match[1] && match[2]) {
        defaults[match[1]] = match[2].trim();
      }
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
export async function extractPropertySignatures(
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
          const isUnion = type.includes('|');
          const unionMembers = isUnion
            ? type
                .split('|')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          props.push({
            name,
            type,
            required: !isOptional,
            isUnion: isUnion || undefined,
            unionMembers: unionMembers && unionMembers.length > 1 ? unionMembers : undefined,
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
 * Extracts layout and style tokens (Tailwind CSS utility classes, z-indices, overflow traps) from component content.
 */

export async function extractVueContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const descriptor = parseSfc(content, filePath);

  const props: ComponentPropContract[] = [];
  const emits: ComponentEmitContract[] = [];
  let slots: string[] = [];
  let slotDetails: ComponentSlotDetail[] | undefined;
  const models: ComponentModelContract[] = [];
  const exposed: string[] = [];

  // 1. Template slots
  if (descriptor.template) {
    slotDetails = extractSlotDetailsFromTemplate(descriptor.template.content);
    slots = slotDetails.map((s) => s.name);
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
        try {
          const sf = ts.createSourceFile('wd.ts', m.text, ts.ScriptTarget.Latest, true);
          let secondArgText = '';
          function findCall(n: ts.Node) {
            if (ts.isCallExpression(n) && n.arguments.length >= 2) {
              secondArgText = n.arguments[1].getText(sf);
              return;
            }
            ts.forEachChild(n, findCall);
          }
          findCall(sf);
          if (secondArgText) {
            defaultsMap = parseDefaultsObject(secondArgText);
          }
        } catch {
          const secondArgMatch = m.text.match(WITH_DEFAULTS_SECOND_ARG_PATTERN);
          if (secondArgMatch && secondArgMatch[1]) {
            defaultsMap = parseDefaultsObject(secondArgMatch[1]);
          }
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

      // 4. Vue 3.4+ defineModel macro extraction
      const defineModelRegex =
        /defineModel\s*(?:<([^>]+)>)?\s*\(\s*(?:['"]([^'"]+)['"]\s*(?:,\s*(\{[\s\S]*?\}))?|(\{[\s\S]*?\}))?\s*\)/g;

      for (const m of fullScript.matchAll(defineModelRegex)) {
        const typeArg = m[1]?.trim();
        const nameArg = m[2]?.trim();
        const optionsArg = m[3] || m[4];

        const modelName = nameArg || 'modelValue';
        let modelType = typeArg || 'any';
        let required = false;
        let defaultValue: string | undefined;

        if (optionsArg) {
          if (optionsArg.includes('required: true')) required = true;
          const typeMatch = optionsArg.match(/type\s*:\s*([A-Za-z0-9_$]+)/);
          if (typeMatch && !typeArg) modelType = typeMatch[1];
          const defMatch = optionsArg.match(/default\s*:\s*([^,\n}]+)/);
          if (defMatch) defaultValue = defMatch[1].trim();
        }

        models.push({
          name: modelName,
          type: modelType,
          required: required || undefined,
          default: defaultValue,
        });

        // Also register as dual prop and emit contract
        if (!props.some((p) => p.name === modelName)) {
          props.push({
            name: modelName,
            type: modelType,
            required,
            default: defaultValue,
          });
        }

        const emitName = `update:${modelName}`;
        if (!emits.some((e) => e.name === emitName)) {
          emits.push({
            name: emitName,
            payload: modelType !== 'any' ? modelType : undefined,
          });
        }
      }

      // 5. Exposed Extraction
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
    slotDetails: slotDetails && slotDetails.length > 0 ? slotDetails : undefined,
    models: models.length > 0 ? models : undefined,
    exposed: exposed.length > 0 ? Array.from(new Set(exposed)) : undefined,
    styleTokens: extractStyleTokens(content),
  };
}

/**
 * Extracts React component contract from .tsx / .jsx / .ts source code.
 */

export async function extractVueComposableContract(filePath: string, content: string): Promise<ComponentContract> {
  const component = basename(filePath, extname(filePath));
  const props: ComponentPropContract[] = [];

  try {
    const paramMatch = content.match(
      new RegExp(`(?:export\\s+)?(?:function\\s+${component}|const\\s+${component}\\s*=\\s*(?:async\\s*)?)\\s*\\(([^)]*)\\)`)
    );
    if (paramMatch && paramMatch[1].trim()) {
      const rawParams = paramMatch[1].split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of rawParams) {
        const [name, defaultVal] = p.split('=').map((s) => s.trim());
        props.push({
          name,
          type: 'any',
          required: defaultVal === undefined,
          default: defaultVal,
        });
      }
    }
  } catch {
    // ignore
  }

  return {
    component,
    framework: 'vue-composable',
    filePath,
    props,
    emits: [],
    slots: [],
  };
}

/**
 * Detects isomorphic render boundary, SSR vs client hydration, and RSC directives.
 */
