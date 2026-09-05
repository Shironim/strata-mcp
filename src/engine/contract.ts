import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { findProjectRoot } from './path-resolver';
import { parse as parseDom, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import { stripQuotes } from './patterns';
import type {
  BoundaryContract,
  BoundaryMethod,
  BoundaryViolation,
  ComponentContract,
  ComponentEmitContract,
  ComponentModelContract,
  ComponentPropContract,
  ComponentSlotDetail,
  ComponentStyleTokens,
  ComponentVariantsInfo,
  ContractOptions,
  DataDependencyInfo,
  FormContract,
  FormFieldContract,
  GlobalSymbolInfo,
  InferredPropDetail,
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

interface ProjectEcosystem {
  hasVue: boolean;
  hasReact: boolean;
  hasAstro: boolean;
}

const projectEcosystemCache = new Map<string, ProjectEcosystem>();

/**
 * Discovers frontend ecosystem dependencies present in the project root.
 */
export function getProjectEcosystem(rootDir: string): ProjectEcosystem {
  if (projectEcosystemCache.has(rootDir)) {
    return projectEcosystemCache.get(rootDir)!;
  }

  let hasVue = false;
  let hasReact = false;
  let hasAstro = false;

  try {
    const pkgPath = join(rootDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkgRaw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['vue'] || deps['@inertiajs/vue3'] || deps['@vitejs/plugin-vue'] || deps['nuxt']) {
        hasVue = true;
      }
      if (deps['react'] || deps['react-dom'] || deps['next'] || deps['@inertiajs/react']) {
        hasReact = true;
      }
      if (deps['astro']) {
        hasAstro = true;
      }
    }
  } catch {
    // ignore
  }

  if (!hasVue && (existsSync(join(rootDir, 'nuxt.config.ts')) || existsSync(join(rootDir, 'nuxt.config.js')))) {
    hasVue = true;
  }
  if (!hasReact && (existsSync(join(rootDir, 'next.config.js')) || existsSync(join(rootDir, 'next.config.ts')) || existsSync(join(rootDir, 'next.config.mjs')))) {
    hasReact = true;
  }
  if (!hasAstro && (existsSync(join(rootDir, 'astro.config.mjs')) || existsSync(join(rootDir, 'astro.config.ts')))) {
    hasAstro = true;
  }

  const result: ProjectEcosystem = { hasVue, hasReact, hasAstro };
  projectEcosystemCache.set(rootDir, result);
  return result;
}

/**
 * Detects the component framework based on 4-Tier Heuristic Matrix:
 * Tier 1: AST Code & Import Signatures in the file (Vue reactivity vs React hooks)
 * Tier 2: Directory Conventions (/composables/ vs /hooks/)
 * Tier 3: Project Root Manifest (package.json dependencies)
 * Tier 4: Safe Neutral Fallback
 */
export function detectFramework(
  filePath: string,
  explicitContent?: string
): 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.vue') return 'vue';
  if (ext === '.astro') return 'astro';

  const isScriptOrJsx = ext === '.tsx' || ext === '.jsx' || ext === '.ts' || ext === '.js';
  if (!isScriptOrJsx) return 'unknown';

  let content = explicitContent;
  if (content === undefined) {
    try {
      if (existsSync(filePath)) {
        content = readFileSync(filePath, 'utf8');
      }
    } catch {
      // ignore
    }
  }

  const normPath = filePath.replace(/\\/g, '/');
  const base = basename(filePath, ext);
  const isComposableName = /^use[A-Z0-9_]/.test(base);

  // --- Tier 1: AST Code & Import Signatures in the file ---
  if (content) {
    const hasVueImportsOrReactivity =
      /\bfrom\s+['"](?:vue|@vue\/[^'"]+|@vueuse\/[^'"]+|pinia|@inertiajs\/vue3|vue-router)['"]/.test(content) ||
      /\b(?:ref|reactive|computed|watch|watchEffect|shallowRef|toRef|toRefs|inject|provide)\s*\(/.test(content);

    const hasReactImportsOrHooks =
      /\bfrom\s+['"](?:react|react-dom|next\/[^'"]+|@tanstack\/react-query)['"]/.test(content) ||
      /\b(?:useState|useEffect|useCallback|useMemo|useRef|useContext|useReducer|useTransition|useId)\s*\(/.test(content);

    if (hasVueImportsOrReactivity && !hasReactImportsOrHooks) {
      return isComposableName || normPath.includes('/composables/') ? 'vue-composable' : 'vue';
    }

    if (hasReactImportsOrHooks && !hasVueImportsOrReactivity) {
      return 'react';
    }
  }

  // --- Tier 2: Directory Conventions ---
  if (normPath.includes('/composables/')) {
    try {
      const rootDir = findProjectRoot(filePath);
      const eco = getProjectEcosystem(rootDir);
      if (eco.hasVue && !eco.hasReact) return 'vue-composable';
    } catch {
      // ignore
    }
  } else if (normPath.includes('/hooks/')) {
    try {
      const rootDir = findProjectRoot(filePath);
      const eco = getProjectEcosystem(rootDir);
      if (eco.hasReact && !eco.hasVue) return 'react';
    } catch {
      // ignore
    }
  }

  // --- Tier 3: Project Root Manifest ---
  try {
    const rootDir = findProjectRoot(filePath);
    const eco = getProjectEcosystem(rootDir);

    if (eco.hasVue && !eco.hasReact) {
      if (isComposableName || normPath.includes('/composables/')) {
        return 'vue-composable';
      }
      return 'vue-composable';
    }

    if (eco.hasReact && !eco.hasVue) {
      return 'react';
    }
  } catch {
    // ignore
  }

  // --- Tier 4: Safe Neutral Fallback ---
  if (ext === '.tsx' || ext === '.jsx') {
    return 'react';
  }

  return 'unknown';
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
export function extractStyleTokens(content: string): ComponentStyleTokens | undefined {
  const classRegex = /\b(?:class|className)\s*=\s*(?:["']([^"']+)["']|`([^`]+)`|\{["']([^"']+)["']\})/g;
  const layoutTraps = new Set<string>();
  const zIndices = new Set<string>();
  const overflow = new Set<string>();
  const positioning = new Set<string>();

  for (const m of content.matchAll(classRegex)) {
    const rawClasses = m[1] || m[2] || m[3] || '';
    const tokens = rawClasses.split(/\s+/).filter(Boolean);

    for (const t of tokens) {
      if (/^overflow(?:-[xy])?-(?:hidden|clip|auto|scroll)$/.test(t)) {
        overflow.add(t);
        layoutTraps.add(t);
      } else if (/^z-(?:0|10|20|30|40|50|auto|\[\S+\])$/.test(t)) {
        zIndices.add(t);
        if (t.startsWith('z-[') || t === 'z-50') {
          layoutTraps.add(t);
        }
      } else if (/^(?:fixed|sticky|absolute|relative)$/.test(t)) {
        positioning.add(t);
        if (t === 'fixed' || t === 'sticky') {
          layoutTraps.add(t);
        }
      } else if (/^(?:inset-0|pointer-events-none|modal|drawer)$/.test(t)) {
        layoutTraps.add(t);
      }
    }
  }

  if (layoutTraps.size === 0 && zIndices.size === 0 && overflow.size === 0 && positioning.size === 0) {
    return undefined;
  }

  return {
    layoutTraps: Array.from(layoutTraps),
    zIndices: Array.from(zIndices),
    overflow: Array.from(overflow),
    positioning: Array.from(positioning),
  };
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
    styleTokens: extractStyleTokens(content),
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
 * Extracts contract for a Vue composable function or module (.js / .ts).
 */
async function extractVueComposableContract(filePath: string, content: string): Promise<ComponentContract> {
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
export function extractRenderBoundary(
  filePath: string,
  content: string,
  framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable'
): RenderBoundaryInfo {
  const normPath = filePath.replace(/\\/g, '/');
  const violations: BoundaryViolation[] = [];

  if (framework === 'vue-composable') {
    return {
      boundary: 'isomorphic',
      isClientHydrated: true,
    };
  }

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
  _framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable',
  selfComponentName?: string
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
    if (
      !COMMON_HOOKS_IGNORE.has(hookName) &&
      !stores.has(hookName) &&
      hookName !== 'useContext' &&
      hookName !== selfComponentName
    ) {
      composables.add(hookName);
    }
  }

  // 4. Inertia Router singleton (Vue 3, React, Svelte, Core) & $inertia global
  const inertiaRouterImportRegex = /\bimport\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]@inertiajs\/(?:vue3|react|svelte|core)['"]/;
  const inertiaRouterUsageRegex = /\brouter\.(?:get|post|put|patch|delete|reload|visit)\b/;
  if (inertiaRouterImportRegex.test(content) || inertiaRouterUsageRegex.test(content)) {
    composables.add('router');
  }

  const inertiaGlobalRegex = /\b\$inertia\.(?:get|post|put|patch|delete|reload|visit)\b/;
  if (inertiaGlobalRegex.test(content)) {
    composables.add('$inertia');
  }

  // 5. Nanostores atom extraction (Astro, React, Vue): useStore($atom)
  const nanostoresRegex = /\buseStore\(\s*([$A-Za-z0-9_]+)\s*\)/g;
  for (const nm of content.matchAll(nanostoresRegex)) {
    if (nm[1]) {
      stores.add(nm[1]);
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
  _framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable'
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

  // 4. Inertia.js Form & Router Mutations (direct URLs, route('...') helpers, and partial reloads)
  const inertiaMutationRegex = /(?:[A-Za-z0-9_$]+|router)\.(post|put|patch|delete)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`])/g;
  for (const m of content.matchAll(inertiaMutationRegex)) {
    const method = m[1].toUpperCase();
    const routeTarget = m[2] ? `route('${m[2]}')` : m[3]?.trim();
    if (routeTarget) {
      mutations.add(`${method} ${routeTarget}`);
      if (routeTarget.startsWith('/') || routeTarget.startsWith('http')) {
        endpoints.add(routeTarget);
      }
    }
  }

  const inertiaReloadRegex = /router\.reload\s*\(\s*\{[\s\S]*?only\s*:\s*\[([^\]]+)\]/g;
  for (const m of content.matchAll(inertiaReloadRegex)) {
    const propsReloaded = m[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    for (const p of propsReloaded) {
      mutations.add(`RELOAD prop:${p}`);
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
 * Infers item fields of an array property iterated via Vue/Nuxt `v-for` or React/Next/Astro `.map()`.
 * Produces structured shapes like `Array<{ id, title, price, customer?: { name } }>`.
 */
function inferArrayItemShape(
  content: string,
  propName: string,
  property?: string
): string | null {
  const aliases = new Set<string>();

  // 1. Vue/Nuxt v-for: v-for="item in prop.data" or v-for="(item, idx) in prop.data"
  const vForTarget = property
    ? `${propName}(?:\\.value)?(?:\\?\\.)?\\.${property}\\b`
    : `${propName}(?:\\.value)?(?![\\.\\?])\\b`;

  const vForRegex = new RegExp(
    `v-for=['"][^'"]*?(?:\\(\\s*([A-Za-z0-9_$]+)(?:\\s*,[^)]*)?\\)|([A-Za-z0-9_$]+))\\s+(?:in|of)\\s+[^'"]*?\\b(?:props\\.)?${vForTarget}`,
    'gi'
  );
  for (const match of content.matchAll(vForRegex)) {
    const alias = match[1] || match[2];
    if (alias && alias !== 'index' && alias !== 'idx' && alias !== 'key') {
      aliases.add(alias);
    }
  }

  // 2. React / Next.js / Astro / JSX .map(): prop.data.map((item) => ...) or prop.map((item) => ...)
  const mapTarget = property
    ? `${propName}(?:\\.value)?(?:\\?\\.)?\\.${property}(?:\\?\\.)?\\.map`
    : `${propName}(?:\\.value)?(?:\\?\\.)?\\.map`;

  const mapRegex = new RegExp(
    `\\b(?:props\\.)?${mapTarget}\\s*\\(\\s*(?:\\(\\s*([A-Za-z0-9_$]+)(?:\\s*,[^)]*)?\\)|([A-Za-z0-9_$]+))\\s*=>`,
    'gi'
  );
  for (const match of content.matchAll(mapRegex)) {
    const alias = match[1] || match[2];
    if (alias && alias !== 'index' && alias !== 'idx' && alias !== 'key') {
      aliases.add(alias);
    }
  }

  if (aliases.size === 0) return null;

  const itemFields = new Map<string, Set<string> | null>();
  const ignoreMethods = new Set([
    'map', 'filter', 'forEach', 'reduce', 'length', 'toString', 'valueOf',
    'includes', 'find', 'findIndex', 'some', 'every', 'slice', 'splice', 'push'
  ]);

  for (const alias of aliases) {
    // Check 2-level deep: alias.field.nestedField or alias.field?.nestedField
    const nestedAccessRegex = new RegExp(
      `\\b${alias}(?:\\?\\.|\\.)([A-Za-z0-9_$]+)(?:\\?\\.|\\.)([A-Za-z0-9_$]+)`,
      'g'
    );
    for (const m of content.matchAll(nestedAccessRegex)) {
      const parentField = m[1];
      const childField = m[2];
      if (parentField && childField && !ignoreMethods.has(childField)) {
        if (!itemFields.has(parentField) || itemFields.get(parentField) === null) {
          itemFields.set(parentField, new Set<string>());
        }
        itemFields.get(parentField)!.add(childField);
      }
    }

    // Single level: alias.field or alias?.field
    const accessRegex = new RegExp(
      `\\b${alias}(?:\\?\\.|\\.)([A-Za-z0-9_$]+)`,
      'g'
    );
    for (const m of content.matchAll(accessRegex)) {
      const field = m[1];
      if (field && !ignoreMethods.has(field)) {
        if (!itemFields.has(field)) {
          itemFields.set(field, null);
        }
      }
    }
  }

  if (itemFields.size === 0) return null;

  const fieldStrings: string[] = [];
  for (const [f, nested] of itemFields.entries()) {
    if (nested && nested.size > 0) {
      fieldStrings.push(`${f}?: { ${Array.from(nested).join(', ')} }`);
    } else {
      fieldStrings.push(f);
    }
  }

  return `Array<{ ${fieldStrings.join(', ')} }>`;
}

/**
 * Infers deep object prop sub-properties accessed across template and script blocks.
 */
export function inferPropsStructure(
  content: string,
  props: ComponentPropContract[]
): InferredPropDetail[] {
  const result: InferredPropDetail[] = [];

  for (const p of props) {
    const propName = p.name;
    const propAccessRegex = new RegExp(
      `(?:props\\.)?\\b${propName}(?:\\.value)?\\?\\.([A-Za-z0-9_$]+)|(?:props\\.)?\\b${propName}(?:\\.value)?\\.([A-Za-z0-9_$]+)`,
      'g'
    );

    const propertiesMap = new Map<string, { type?: string; usage?: string }>();

    for (const match of content.matchAll(propAccessRegex)) {
      const property = match[1] || match[2];
      if (
        !property ||
        property === 'value' ||
        property === 'map' ||
        property === 'filter' ||
        property === 'forEach' ||
        property === 'reduce' ||
        property === 'length' ||
        property === 'slice' ||
        property === 'splice' ||
        property === 'find' ||
        property === 'findIndex' ||
        property === 'includes' ||
        property === 'some' ||
        property === 'every'
      ) {
        continue;
      }

      let inferredType = 'any';
      let usage: string | undefined;

      const vForRegex = new RegExp(
        `v-for=['"][^'"]*\\bin\\s+[^'"]*\\b${propName}[^'"]*\\.${property}`,
        'i'
      );
      if (
        vForRegex.test(content) ||
        content.includes(`.${property}.map(`) ||
        content.includes(`.${property}.length`) ||
        content.includes(`:${property}="`)
      ) {
        const itemShape = inferArrayItemShape(content, propName, property);
        inferredType = itemShape || 'Array<Object>';
        usage = itemShape
          ? 'used in v-for / list rendering (item fields mapped)'
          : 'used in v-for / list rendering';
      } else if (property === 'links' || property === 'meta') {
        inferredType = property === 'links' ? 'Array' : 'Object';
        usage = 'pagination / navigation metadata';
      } else if (
        property === 'total' ||
        property === 'count' ||
        property === 'page' ||
        property === 'id' ||
        property === 'price' ||
        property.includes('harga') ||
        property.includes('total')
      ) {
        inferredType = 'Number';
        usage = 'numeric metric / identifier';
      } else if (
        content.includes(`v-model="${propName}.${property}"`) ||
        content.includes(`v-model:`) ||
        property === 'search' ||
        property === 'query'
      ) {
        inferredType = 'String';
        usage = 'bound to form input / filter';
      } else if (
        content.includes(`v-if="${propName}.${property}"`) ||
        content.includes(`!${propName}.${property}`) ||
        property.startsWith('is_') ||
        property.startsWith('has_')
      ) {
        inferredType = 'Boolean';
        usage = 'conditional flag';
      }

      if (
        !propertiesMap.has(property) ||
        (inferredType !== 'any' && propertiesMap.get(property)?.type === 'any')
      ) {
        propertiesMap.set(property, { type: inferredType, usage });
      }
    }

    // Check if the root prop itself is directly iterated as an array (e.g. v-for="item in items" or items.map(...))
    const directItemShape = inferArrayItemShape(content, propName);
    if (directItemShape) {
      propertiesMap.set('[]', {
        type: directItemShape,
        usage: 'directly iterated array (item fields mapped)',
      });
    }

    if (propertiesMap.size > 0) {
      result.push({
        propName,
        properties: Array.from(propertiesMap.entries()).map(([property, info]) => ({
          property,
          inferredType: info.type,
          usageSnippet: info.usage,
        })),
      });
    }
  }

  return result;
}

/**
 * Detects global, Ziggy, or auto-imported symbols called in the component.
 */
export function detectGlobalSymbols(content: string): GlobalSymbolInfo[] {
  const globals: GlobalSymbolInfo[] = [];
  const foundNames = new Set<string>();

  // 1. Detect Ziggy route helper: `route(...)`
  if (/\broute\s*\([^)]*\)/.test(content)) {
    if (!foundNames.has('route')) {
      foundNames.add('route');
      globals.push({
        name: 'route',
        category: 'ziggy-route',
        hint: 'Ziggy Route Helper (Global)',
      });
    }
  }

  // 2. Detect Vue / Inertia / Nuxt special template/script globals
  const specialGlobals = [
    { pattern: /\$page\b/, name: '$page', hint: 'Inertia Shared Page Props' },
    { pattern: /\$inertia\b/, name: '$inertia', hint: 'Inertia Router Instance' },
    { pattern: /\$router\b/, name: '$router', hint: 'Vue Router Instance' },
    { pattern: /\$route\b/, name: '$route', hint: 'Vue Current Route' },
    { pattern: /\$attrs\b/, name: '$attrs', hint: 'Vue Fallthrough Attributes' },
    { pattern: /\$slots\b/, name: '$slots', hint: 'Vue Slots' },
    { pattern: /\$t\b/, name: '$t', hint: 'vue-i18n Translation Helper' },
    { pattern: /\$pinia\b/, name: '$pinia', hint: 'Pinia Root Instance' },
    { pattern: /\$config\b/, name: '$config', hint: 'Nuxt Runtime Config' },
  ];

  for (const sg of specialGlobals) {
    if (sg.pattern.test(content) && !foundNames.has(sg.name)) {
      foundNames.add(sg.name);
      globals.push({
        name: sg.name,
        category: 'inferred-global',
        hint: sg.hint,
      });
    }
  }

  // 3. Detect framework-level auto-imported composables (Nuxt, Vite unplugin-auto-import)
  const commonFrontendAutoImports = [
    { name: 'navigateTo', hint: 'Nuxt / Frontend Router Navigation Helper' },
    { name: 'useFetch', hint: 'Nuxt / Universal Data Fetching Composable' },
    { name: 'useAsyncData', hint: 'Nuxt Async Data Fetching Composable' },
    { name: 'useHead', hint: 'Unhead / SEO Meta Composable' },
    { name: 'useSeoMeta', hint: 'Nuxt SEO Meta Composable' },
    { name: 'useRouter', hint: 'Vue Router Navigation Composable' },
    { name: 'useRoute', hint: 'Vue Route Query & Params Composable' },
    { name: 'useLocale', hint: 'i18n Locale Composable' },
  ];

  for (const cai of commonFrontendAutoImports) {
    if (
      new RegExp(`\\b${cai.name}\\s*\\(`).test(content) &&
      !foundNames.has(cai.name) &&
      !content.includes(`import { ${cai.name}`) &&
      !content.includes(`import ${cai.name}`) &&
      !content.includes(`const ${cai.name}`) &&
      !content.includes(`function ${cai.name}`)
    ) {
      foundNames.add(cai.name);
      globals.push({
        name: cai.name,
        category: 'auto-import',
        hint: cai.hint,
      });
    }
  }

  // 4. Detect common global/auto-imported helper function calls
  const helperCallMatches = content.matchAll(/\b(format[A-Z][A-Za-z0-9_$]+)\s*\(/g);
  for (const m of helperCallMatches) {
    const name = m[1];
    if (
      !foundNames.has(name) &&
      !content.includes(`import { ${name}`) &&
      !content.includes(`const ${name}`) &&
      !content.includes(`function ${name}`)
    ) {
      foundNames.add(name);
      globals.push({
        name,
        category: 'auto-import',
        hint: 'Auto-Imported / Composable Helper',
      });
    }
  }

  return globals;
}

/**
 * Computes 1-based line number from a character offset.
 */
function getLineFromOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Extracts payload object property keys from a JS object literal snippet.
 */
function extractObjectLiteralKeys(objSnippet: string): string[] {
  const keys: string[] = [];
  const keyRegex = /(?:^|[{,\n])\s*([A-Za-z0-9_$]+)\s*:/g;
  for (const m of objSnippet.matchAll(keyRegex)) {
    if (m[1] && m[1] !== 'method' && m[1] !== 'headers' && m[1] !== 'params' && m[1] !== 'body' && m[1] !== 'key') {
      keys.push(m[1]);
    }
  }
  return keys;
}

/**
 * Extracts universal ingress & egress data fetching boundary contracts (Inertia, Nuxt, Next/React, Astro).
 */
export function extractBoundaryContracts(
  content: string,
  _framework: string
): BoundaryContract[] {
  const boundaries: BoundaryContract[] = [];

  // 1. Inertia useForm: const form = useForm({ ... })
  const formVarFields = new Map<string, string[]>();
  const inertiaUseFormRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*useForm\s*(?:<[^>]+>)?\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?(\{[\s\S]*?\})\s*\)/g;
  for (const m of content.matchAll(inertiaUseFormRegex)) {
    const varName = m[1];
    const fields = extractObjectLiteralKeys(m[2]);
    formVarFields.set(varName, fields);
  }

  // 1b. Inertia form submissions: form.post(...), form.put(...), etc.
  const formSubmitRegex = /\b([A-Za-z0-9_$]+)\.(post|put|patch|delete|get)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`]|([A-Za-z0-9_$]+))/g;
  for (const m of content.matchAll(formSubmitRegex)) {
    const varName = m[1];
    if (varName === 'axios' || varName === 'router' || varName === 'api' || varName === 'http') {
      continue;
    }
    const isKnownForm = formVarFields.has(varName) || /form/i.test(varName);
    if (!isKnownForm) {
      continue;
    }

    const method = m[2].toUpperCase() as BoundaryMethod;
    const isZiggy = Boolean(m[3]);
    const ziggyName = m[3];
    const literalUrl = m[4];
    const varUrl = m[5];

    let targetEndpoint = '';
    let endpointSource: BoundaryContract['endpointSource'] = 'literal';

    if (isZiggy) {
      targetEndpoint = `route('${ziggyName}')`;
      endpointSource = 'ziggy-route';
    } else if (literalUrl) {
      targetEndpoint = literalUrl.trim();
      endpointSource = literalUrl.includes('${') ? 'template-literal' : 'literal';
    } else if (varUrl) {
      targetEndpoint = varUrl.trim();
      endpointSource = 'variable';
    }

    if (targetEndpoint) {
      const payloadKeys = formVarFields.get(varName) || [];
      const line = getLineFromOffset(content, m.index || 0);
      boundaries.push({
        boundaryType: 'inertia-form',
        method,
        targetEndpoint,
        endpointSource,
        payloadKeys: payloadKeys.length > 0 ? payloadKeys : undefined,
        optimisticUpdate: false,
        loc: { line }
      });
    }
  }

  // 1c. Inertia router calls: router.post(...), router.visit(...)
  const inertiaRouterRegex = /\brouter\.(post|put|patch|delete|get|visit)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`])/g;
  for (const m of content.matchAll(inertiaRouterRegex)) {
    const rawMethod = m[1].toUpperCase();
    const method = (rawMethod === 'VISIT' ? 'GET' : rawMethod) as BoundaryMethod;
    const isZiggy = Boolean(m[2]);
    const targetEndpoint = isZiggy ? `route('${m[2]}')` : (m[3]?.trim() || '');
    const endpointSource = isZiggy ? 'ziggy-route' : (targetEndpoint.includes('${') ? 'template-literal' : 'literal');
    const line = getLineFromOffset(content, m.index || 0);

    const afterCall = content.substring((m.index || 0) + m[0].length);
    let payloadKeys: string[] | undefined;
    const secondArgMatch = afterCall.match(/^\s*,\s*(\{[\s\S]*?\})/);
    if (secondArgMatch) {
      payloadKeys = extractObjectLiteralKeys(secondArgMatch[1]);
    }

    boundaries.push({
      boundaryType: 'inertia-router',
      method,
      targetEndpoint,
      endpointSource,
      payloadKeys: payloadKeys && payloadKeys.length > 0 ? payloadKeys : undefined,
      optimisticUpdate: false,
      loc: { line }
    });
  }

  // 2. Nuxt useFetch & $fetch
  const nuxtFetchRegex = /\b(useFetch|\$fetch)\s*(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`](?:[\s\S]*?method\s*:\s*['"]([A-Za-z]+)['"])?/g;
  for (const m of content.matchAll(nuxtFetchRegex)) {
    const targetEndpoint = m[2].trim();
    const method = (m[3]?.toUpperCase() || 'GET') as BoundaryMethod;
    const line = getLineFromOffset(content, m.index || 0);
    const endpointSource = targetEndpoint.includes('${') ? 'template-literal' : 'literal';

    let payloadKeys: string[] | undefined;
    const afterMatch = content.substring(m.index || 0, (m.index || 0) + 300);
    const bodyMatch = afterMatch.match(/body\s*:\s*(\{[\s\S]*?\})/);
    if (bodyMatch) {
      payloadKeys = extractObjectLiteralKeys(bodyMatch[1]);
    }

    boundaries.push({
      boundaryType: 'nuxt-fetch',
      method,
      targetEndpoint,
      endpointSource,
      payloadKeys: payloadKeys && payloadKeys.length > 0 ? payloadKeys : undefined,
      optimisticUpdate: false,
      loc: { line }
    });
  }

  // 3. TanStack Query: useMutation / useQuery
  const tanstackMutationRegex = /useMutation\s*\(\s*\{[\s\S]*?mutationFn\s*:\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/g;
  for (const m of content.matchAll(tanstackMutationRegex)) {
    const line = getLineFromOffset(content, m.index || 0);
    const mutationBlock = content.substring(m.index || 0, (m.index || 0) + 400);
    const urlMatch = mutationBlock.match(/['"`](\/(?:api\/)?[^'"`]+)['"`]/);
    const targetEndpoint = urlMatch ? urlMatch[1] : 'mutationFn';
    const methodMatch = mutationBlock.match(/method\s*:\s*['"]([A-Z]+)['"]/i) || mutationBlock.match(/\.(post|put|patch|delete)\b/i);
    const method = (methodMatch ? (methodMatch[1] || methodMatch[2]).toUpperCase() : 'POST') as BoundaryMethod;

    boundaries.push({
      boundaryType: 'tanstack-query',
      method,
      targetEndpoint,
      endpointSource: urlMatch ? (targetEndpoint.includes('${') ? 'template-literal' : 'literal') : 'action-symbol',
      optimisticUpdate: /onMutate\s*:/.test(mutationBlock),
      loc: { line }
    });
  }

  // 4. Server Actions (Next.js / Astro actions)
  const serverActionRegex = /(?:action\s*=\s*\{([A-Za-z0-9_$]+)\}|async\s+function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*['"]use server['"])/g;
  for (const m of content.matchAll(serverActionRegex)) {
    const actionName = m[1] || m[2];
    const line = getLineFromOffset(content, m.index || 0);
    boundaries.push({
      boundaryType: 'server-action',
      method: 'POST',
      targetEndpoint: actionName,
      endpointSource: 'action-symbol',
      optimisticUpdate: false,
      loc: { line }
    });
  }

  // 5. Native fetch & Axios
  const nativeFetchRegex = /\bfetch\s*\(\s*['"`](\/(?:api\/)?[^'"`]+)['"`](?:[\s\S]*?method\s*:\s*['"]([A-Za-z]+)['"])?/g;
  for (const m of content.matchAll(nativeFetchRegex)) {
    const targetEndpoint = m[1].trim();
    const method = (m[2]?.toUpperCase() || 'GET') as BoundaryMethod;
    const line = getLineFromOffset(content, m.index || 0);

    const alreadyCaptured = boundaries.some((b) => b.loc?.line === line);
    if (!alreadyCaptured) {
      boundaries.push({
        boundaryType: 'native-fetch',
        method,
        targetEndpoint,
        endpointSource: targetEndpoint.includes('${') ? 'template-literal' : 'literal',
        loc: { line }
      });
    }
  }

  return boundaries;
}

/**
 * Extracts form and input payload dictionary across template/JSX and script blocks.
 */
export function extractFormContracts(
  content: string,
  templateContent?: string
): FormContract[] {
  const forms: FormContract[] = [];
  const fields: FormFieldContract[] = [];
  const fieldKeySet = new Set<string>();
  let isMultipart = false;

  const searchContent = templateContent || content;

  // 1. Scan template tags: <input>, <select>, <textarea>, <Input, <Select, <Textarea
  const tagRegex = /<(?:input|select|textarea|Input|Select|Textarea)\b([^>]*?)(?:\/?>|>)/gi;
  for (const m of searchContent.matchAll(tagRegex)) {
    const attrs = m[1];

    const typeMatch = attrs.match(/\btype=['"]([^'"]+)['"]/i);
    const rawType = typeMatch ? typeMatch[1].toLowerCase() : 'text';

    if (rawType === 'file') {
      isMultipart = true;
    }

    const isRequired = /\brequired\b/i.test(attrs) || /:required=['"]true['"]/i.test(attrs);

    let key = '';
    let binding: string | undefined;

    const vModelMatch = attrs.match(/v-model(?::[A-Za-z0-9_$]+)?=['"]([^'"]+)['"]/i);
    if (vModelMatch) {
      binding = vModelMatch[1].trim();
      const parts = binding.split('.');
      key = parts[parts.length - 1];
    } else {
      const nameMatch = attrs.match(/\bname=['"]([^'"]+)['"]/i);
      if (nameMatch) {
        key = nameMatch[1].trim();
        binding = key;
      }
    }

    if (key && !fieldKeySet.has(key)) {
      fieldKeySet.add(key);
      fields.push({
        key,
        type: rawType,
        required: isRequired,
        binding
      });
    }
  }

  // 2. Scan script for useForm({ ... }) initial keys
  const inertiaUseFormRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*useForm\s*(?:<[^>]+>)?\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?(\{[\s\S]*?\})\s*\)/g;
  for (const m of content.matchAll(inertiaUseFormRegex)) {
    const bindingName = m[1];
    const declaredKeys = extractObjectLiteralKeys(m[2]);

    for (const k of declaredKeys) {
      if (!fieldKeySet.has(k)) {
        fieldKeySet.add(k);
        const isFileField = new RegExp(`${k}\\s*:\\s*(?:null|new File)`).test(m[2]);
        fields.push({
          key: k,
          type: isFileField ? 'file' : 'unknown',
          required: false,
          binding: `${bindingName}.${k}`
        });
        if (isFileField) isMultipart = true;
      }
    }
  }

  if (fields.length > 0 || isMultipart) {
    forms.push({
      binding: 'form',
      isMultipart,
      fields
    });
  }

  return forms;
}

export interface ExtractContractOptions {
  inferProps?: boolean;
  resolveGlobals?: boolean;
}

/**
 * Public facade: extracts the public contract of a component (.vue, .tsx, .jsx, .astro).
 */
export async function extractComponentContract(
  filePath: string,
  explicitContentOrOptions?: string | ExtractContractOptions,
  maybeOptions?: ExtractContractOptions
): Promise<ComponentContract> {
  const resolvedPath = resolve(filePath);
  const explicitContent =
    typeof explicitContentOrOptions === 'string' ? explicitContentOrOptions : undefined;
  const options: ExtractContractOptions =
    typeof explicitContentOrOptions === 'object'
      ? explicitContentOrOptions
      : maybeOptions || { inferProps: true, resolveGlobals: true };

  const content =
    explicitContent !== undefined
      ? explicitContent
      : await fs.readFile(resolvedPath, 'utf8');
  const framework = detectFramework(resolvedPath, content);

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
    case 'vue-composable':
      baseContract = await extractVueComposableContract(resolvedPath, content);
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

  const renderBoundary = framework === 'vue-composable'
    ? undefined
    : extractRenderBoundary(resolvedPath, content, framework);
  const stateDependencies = extractStateDependencies(content, framework, baseContract.component);
  const dataDependencies = extractDataDependencies(content, framework);
  const variants = extractComponentVariants(content, baseContract.props);

  const boundaryContracts = extractBoundaryContracts(content, framework);
  const formContracts = extractFormContracts(content);

  const shouldInferProps = options.inferProps !== false;
  const shouldResolveGlobals = options.resolveGlobals !== false;

  const inferredProps = shouldInferProps
    ? inferPropsStructure(content, baseContract.props)
    : undefined;
  const globalSymbols = shouldResolveGlobals
    ? detectGlobalSymbols(content)
    : undefined;

  return {
    ...baseContract,
    variants,
    renderBoundary,
    stateDependencies,
    dataDependencies,
    boundaryContracts: boundaryContracts.length > 0 ? boundaryContracts : undefined,
    formContracts: formContracts.length > 0 ? formContracts : undefined,
    inferredProps: inferredProps && inferredProps.length > 0 ? inferredProps : undefined,
    globalSymbols: globalSymbols && globalSymbols.length > 0 ? globalSymbols : undefined,
  };
}

export { formatContractAsText } from './formatter';

