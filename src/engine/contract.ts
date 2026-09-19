import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { findProjectRoot } from './path-resolver';
import ts from 'typescript';
import { executeAstGrep, isBinaryExecutionError } from './astgrep';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import { stripQuotes, escapeRegExp } from './patterns';
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
  StateAccessMode,
  StateDependencyInfo,
  StateDependencyItem,
} from '../types';

import {
  extractVueContract,
  extractVueComposableContract,
} from './parsers/contract-vue';
import { extractReactContract } from './parsers/contract-react';
import { extractAstroContract } from './parsers/contract-astro';
import {
  extractStateDependencies,
  extractDataDependencies,
  inferArrayItemShape,
} from './parsers/state-dependency';

// Re-export submodules for 100% backward compatibility
export * from './parsers/contract-vue';
export * from './parsers/contract-react';
export * from './parsers/contract-astro';
export * from './parsers/state-dependency';

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

export const COMMON_HOOKS_IGNORE = new Set([
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


