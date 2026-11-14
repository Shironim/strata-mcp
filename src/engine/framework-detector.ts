import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Evidence, FrontendFramework, ProjectOwnershipInfo } from '../types';
import { resolveProjectOwnership } from './project-ownership';
import { moduleDirective } from './parsers/ts-syntax';
import ts from 'typescript';
import { reactBindings } from './parsers/react-bindings';

export interface FrameworkVersionInfo {
  rawVersion: string;
  major: number;
  minor: number;
  patch: number;
}

export interface ProjectFrameworkInfo {
  rawVersion?: string;
  major?: number;
  minor?: number;
  patch?: number;
  configFile?: string;
}

export interface ProjectEcosystem {
  frameworks: Partial<Record<FrontendFramework, ProjectFrameworkInfo>>;
  hasVue: boolean;
  hasNuxt: boolean;
  hasReact: boolean;
  hasNext: boolean;
  hasAstro: boolean;
  hasSvelte: boolean;
  hasSolid: boolean;
}

export interface FrameworkDetectionResult {
  projectContext?: ProjectOwnershipInfo;
  framework: FrontendFramework;
  version?: string;
  majorVersion?: number;
  minorVersion?: number;
  evidence: Evidence;
}

/**
 * Parses semver string like "^3.5.13", "~18.2.0", ">=5.0.0" into numeric parts.
 */
export function parseSemver(versionStr?: string): FrameworkVersionInfo | undefined {
  if (!versionStr) return undefined;
  const match = versionStr.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return {
    rawVersion: versionStr,
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] ? parseInt(match[3], 10) : 0,
  };
}

export function clearEcosystemCache(): void {
  // Kept for callers; ecosystem information is read fresh.
}

/**
 * Discovers frontend framework dependencies, versions, and config files from project root.
 */
export function getProjectEcosystem(rootDir: string): ProjectEcosystem {
  const frameworks: Partial<Record<FrontendFramework, ProjectFrameworkInfo>> = {};

  try {
    const pkgPath = join(rootDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps: Record<string, string> = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      // Nuxt
      if (deps['nuxt'] || deps['nuxt3']) {
        const parsed = parseSemver(deps['nuxt'] || deps['nuxt3']);
        frameworks.nuxt = { rawVersion: deps['nuxt'] || deps['nuxt3'], ...parsed };
      }

      // Vue
      if (deps['vue'] || deps['@inertiajs/vue3'] || deps['@vitejs/plugin-vue']) {
        const parsed = parseSemver(deps['vue']);
        frameworks.vue = { rawVersion: deps['vue'], ...parsed };
      }

      // Next.js
      if (deps['next']) {
        const parsed = parseSemver(deps['next']);
        frameworks.next = { rawVersion: deps['next'], ...parsed };
      }

      // React
      if (deps['react'] || deps['react-dom'] || deps['@inertiajs/react']) {
        const parsed = parseSemver(deps['react']);
        frameworks.react = { rawVersion: deps['react'], ...parsed };
      }

      // Astro
      if (deps['astro']) {
        const parsed = parseSemver(deps['astro']);
        frameworks.astro = { rawVersion: deps['astro'], ...parsed };
      }

      // Svelte
      if (deps['svelte']) {
        const parsed = parseSemver(deps['svelte']);
        frameworks.svelte = { rawVersion: deps['svelte'], ...parsed };
      }

      // SolidJS
      if (deps['solid-js'] || deps['vite-plugin-solid']) {
        const parsed = parseSemver(deps['solid-js']);
        frameworks.solid = { rawVersion: deps['solid-js'], ...parsed };
      }
    }
  } catch {
    // Ignore invalid or missing package.json
  }

  // Detect config files
  const checkConfig = (fileNames: string[], fw: FrontendFramework) => {
    for (const name of fileNames) {
      if (existsSync(join(rootDir, name))) {
        if (!frameworks[fw]) frameworks[fw] = {};
        frameworks[fw]!.configFile = name;
        break;
      }
    }
  };

  checkConfig(['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'], 'nuxt');
  checkConfig(['next.config.js', 'next.config.ts', 'next.config.mjs'], 'next');
  checkConfig(['astro.config.mjs', 'astro.config.ts', 'astro.config.js'], 'astro');
  checkConfig(['svelte.config.js', 'svelte.config.ts'], 'svelte');

  const result: ProjectEcosystem = {
    frameworks,
    hasVue: Boolean(frameworks.vue || frameworks.nuxt),
    hasNuxt: Boolean(frameworks.nuxt),
    hasReact: Boolean(frameworks.react || frameworks.next),
    hasNext: Boolean(frameworks.next),
    hasAstro: Boolean(frameworks.astro),
    hasSvelte: Boolean(frameworks.svelte),
    hasSolid: Boolean(frameworks.solid),
  };

  return result;
}

/**
 * Multi-tier deterministic framework detector.
 * Tier 1: File Extension
 * Tier 2: Explicit AST Imports & Macros
 * Tier 3: Project Root Manifest & Config
 * Tier 4: Directory Convention & Neutral Fallback
 */
export function detectFrameworkWithEvidence(
  filePath: string,
  explicitContent?: string,
  explicitRootDir?: string
): FrameworkDetectionResult {
  const projectContext = resolveProjectOwnership(filePath, explicitRootDir);
  return { ...detectFrameworkInProject(filePath, explicitContent, projectContext), projectContext };
}

function detectFrameworkInProject(filePath: string, explicitContent: string | undefined, context: ProjectOwnershipInfo): FrameworkDetectionResult {
  const ext = extname(filePath).toLowerCase();
  const eco = context.ownerRoot ? getProjectEcosystem(context.ownerRoot) : undefined;
  if (eco) {
    eco.hasNext = context.applicationFramework === 'next';
    eco.hasNuxt = context.applicationFramework === 'nuxt';
  }

  // --- Tier 1: File Extension ---
  if (ext === '.svelte') {
    const svelteInfo = eco?.frameworks.svelte;
    return {
      framework: 'svelte',
      version: svelteInfo?.rawVersion,
      majorVersion: svelteInfo?.major,
      minorVersion: svelteInfo?.minor,
      evidence: {
        basis: 'source',
        resolution: 'resolved',
        method: 'file-extension',
        reason: '.svelte files are strictly Svelte components',
      },
    };
  }

  if (ext === '.astro') {
    const astroInfo = eco?.frameworks.astro;
    return {
      framework: 'astro',
      version: astroInfo?.rawVersion,
      majorVersion: astroInfo?.major,
      minorVersion: astroInfo?.minor,
      evidence: {
        basis: 'source',
        resolution: 'resolved',
        method: 'file-extension',
        reason: '.astro files are strictly Astro SFCs',
      },
    };
  }

  if (ext === '.vue') {
    const isNuxt = eco?.hasNuxt;
    const fw: FrontendFramework = isNuxt ? 'nuxt' : 'vue';
    const info = isNuxt ? eco?.frameworks.nuxt : eco?.frameworks.vue;
    return {
      framework: fw,
      version: info?.rawVersion,
      majorVersion: info?.major,
      minorVersion: info?.minor,
      evidence: {
        basis: 'source',
        resolution: 'resolved',
        method: 'file-extension',
        reason: isNuxt ? '.vue file within Nuxt project' : '.vue file is Vue SFC',
      },
    };
  }

  // Read content if not provided
  let content = explicitContent;
  if (content === undefined && existsSync(filePath)) {
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // ignore
    }
  }

  // --- Tier 2: Explicit AST Imports & Macros ---
  if (content) {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true,
      /\.[jt]sx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const modules = new Set<string>();
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        const valueImport = !clause || (!clause.isTypeOnly && (clause.name || !clause.namedBindings
          || ts.isNamespaceImport(clause.namedBindings) || clause.namedBindings.elements.some(item => !item.isTypeOnly)));
        if (valueImport) modules.add(statement.moduleSpecifier.text);
      }
    }
    const bindings = reactBindings(sf);
    const calls = new Set<string>();
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !bindings.binding(node.expression)) calls.add(node.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(sf);
    const imports = (pattern: RegExp) => [...modules].some(name => pattern.test(name));
    const unboundCall = (names: string[]) => names.some(name => calls.has(name));
    // 2a. SolidJS check (Prohibit misclassifying Solid as React)
    const hasSolidImports = imports(/^solid-js(?:\/(?:web|store|html))?$/);
    const hasSolidPragma = (ts.getLeadingCommentRanges(content, 0) ?? [])
      .some(range => /@jsxImportSource\s+solid-js\b/.test(content.slice(range.pos, range.end)));
    const hasSolidSignals = unboundCall(['createSignal', 'createEffect', 'createMemo', 'createResource', 'createStore']);

    // 2b. Next.js check
    const hasReactDirective = /\.[jt]sx?$/.test(filePath) && Boolean(
      moduleDirective(content, 'use client') || moduleDirective(content, 'use server'));
    const hasNextImports = imports(/^(?:next\/|@next\/)/);

    // 2c. Nuxt check
    const hasNuxtImports = imports(/^(?:#app|#imports|#components|nuxt\/.+)$/);
    const hasNuxtMacros = unboundCall([
      'definePageMeta', 'useAsyncData', 'useFetch', 'defineNuxtComponent', 'defineNuxtRouteMiddleware',
      'useCookie', 'useRuntimeConfig', 'navigateTo', 'useNuxtApp',
    ]);

    // 2d. React check
    const hasReactImports = imports(/^(?:react|react-dom|react\/.+|@tanstack\/react-query)$/);
    const hasReactHooks = unboundCall(['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext', 'useReducer', 'useTransition', 'useId']);

    // 2e. Vue check
    const hasVueImports = imports(/^(?:vue|@vue\/.+|@vueuse\/.+|pinia|@inertiajs\/vue3|vue-router)$/);
    const hasVueReactivity = unboundCall(['ref', 'reactive', 'computed', 'watch', 'watchEffect', 'shallowRef', 'toRef', 'toRefs', 'inject', 'provide']);

    // Evaluation precedence:
    if (hasSolidImports || hasSolidPragma || (hasSolidSignals && !hasReactImports && !hasReactHooks && !hasVueImports && !hasNextImports && !hasNuxtImports)) {
      const solidInfo = eco?.frameworks.solid;
      return {
        framework: 'solid',
        version: solidInfo?.rawVersion,
        majorVersion: solidInfo?.major,
        minorVersion: solidInfo?.minor,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'ast-import-signature',
          reason: hasSolidImports ? 'Direct solid-js module import' : 'SolidJS reactivity primitives without React',
        },
      };
    }

    if (hasNextImports) {
      const nextInfo = eco?.frameworks.next;
      return {
        framework: 'next',
        version: nextInfo?.rawVersion,
        majorVersion: nextInfo?.major,
        minorVersion: nextInfo?.minor,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'ast-import-signature',
          reason: 'Value import from next/* or @next/*',
        },
      };
    }

    if (hasNuxtImports || (hasNuxtMacros && !hasReactImports && !hasVueImports && !eco?.hasNext)) {
      const nuxtInfo = eco?.frameworks.nuxt;
      return {
        framework: 'nuxt',
        version: nuxtInfo?.rawVersion,
        majorVersion: nuxtInfo?.major,
        minorVersion: nuxtInfo?.minor,
        evidence: {
          basis: hasNuxtImports ? 'source' : 'heuristic',
          resolution: hasNuxtImports ? 'resolved' : 'candidate',
          method: hasNuxtImports ? 'ast-import-signature' : 'unbound-call-convention',
          reason: hasNuxtImports ? 'Nuxt virtual alias import (#app/#imports)' : 'Nuxt compiler macro (e.g. definePageMeta)',
        },
      };
    }

    if (hasReactImports || hasReactHooks || hasReactDirective) {
      const isNextProject = eco?.hasNext;
      const fw: FrontendFramework = isNextProject ? 'next' : 'react';
      const info = isNextProject ? eco?.frameworks.next : eco?.frameworks.react;
      return {
        framework: fw,
        version: info?.rawVersion,
        majorVersion: info?.major,
        minorVersion: info?.minor,
        evidence: {
          basis: hasReactImports || isNextProject ? 'source' : 'heuristic',
          resolution: hasReactImports || isNextProject ? 'resolved' : 'candidate',
          method: hasReactImports ? 'ast-import-signature' : isNextProject ? 'project-manifest' : hasReactDirective ? 'react-directive-convention' : 'unbound-call-convention',
          reason: hasReactImports ? 'React value import' : isNextProject ? 'Next project ecosystem with React syntax' : hasReactDirective ? 'React RSC directive; does not identify Next.js or prove bundler support' : 'Unbound conventional React hook call',
        },
      };
    }

    if (hasVueImports || hasVueReactivity) {
      const isNuxt = eco?.hasNuxt;
      const fw: FrontendFramework = isNuxt ? 'nuxt' : 'vue';
      const info = isNuxt ? eco?.frameworks.nuxt : eco?.frameworks.vue;
      return {
        framework: fw,
        version: info?.rawVersion,
        majorVersion: info?.major,
        minorVersion: info?.minor,
        evidence: {
          basis: hasVueImports || isNuxt ? 'source' : 'heuristic',
          resolution: hasVueImports || isNuxt ? 'resolved' : 'candidate',
          method: hasVueImports ? 'ast-import-signature' : isNuxt ? 'project-manifest' : 'unbound-call-convention',
          reason: hasVueImports ? 'Vue value import' : isNuxt ? 'Nuxt project ecosystem with Vue syntax' : 'Unbound conventional Vue reactivity call',
        },
      };
    }
  }

  // --- Tier 3: Project Root Manifest & Config ---
  if (eco) {
    // If project is pure SolidJS (no React) and file is JSX/TSX
    if (eco.hasSolid && !eco.hasReact && (ext === '.tsx' || ext === '.jsx')) {
      return {
        framework: 'solid',
        version: eco.frameworks.solid?.rawVersion,
        majorVersion: eco.frameworks.solid?.major,
        minorVersion: eco.frameworks.solid?.minor,
        evidence: {
          basis: 'derived',
          resolution: 'resolved',
          method: 'project-manifest',
          reason: 'Project manifest declares solid-js dependency without react',
        },
      };
    }

    // If project is Next.js
    if (eco.hasNext) {
      return {
        framework: 'next',
        version: eco.frameworks.next?.rawVersion,
        majorVersion: eco.frameworks.next?.major,
        minorVersion: eco.frameworks.next?.minor,
        evidence: {
          basis: 'derived',
          resolution: 'resolved',
          method: 'project-manifest',
          reason: 'Project root contains next manifest or config',
        },
      };
    }

    // If project is Nuxt
    if (eco.hasNuxt) {
      return {
        framework: 'nuxt',
        version: eco.frameworks.nuxt?.rawVersion,
        majorVersion: eco.frameworks.nuxt?.major,
        minorVersion: eco.frameworks.nuxt?.minor,
        evidence: {
          basis: 'derived',
          resolution: 'resolved',
          method: 'project-manifest',
          reason: 'Project root contains nuxt manifest or config',
        },
      };
    }

    // Pure React
    if (eco.hasReact && !eco.hasVue && (ext === '.tsx' || ext === '.jsx')) {
      return {
        framework: 'react',
        version: eco.frameworks.react?.rawVersion,
        majorVersion: eco.frameworks.react?.major,
        minorVersion: eco.frameworks.react?.minor,
        evidence: {
          basis: 'derived',
          resolution: 'resolved',
          method: 'project-manifest',
          reason: 'Project manifest declares react dependency',
        },
      };
    }
  }

  // --- Tier 4: Directory Convention & Neutral Fallback ---
  const normPath = filePath.replace(/\\/g, '/');
  if (normPath.includes('/composables/')) {
    const isNuxt = eco?.hasNuxt;
    return {
      framework: isNuxt ? 'nuxt' : 'vue',
      version: isNuxt ? eco?.frameworks.nuxt?.rawVersion : eco?.frameworks.vue?.rawVersion,
      evidence: {
        basis: 'heuristic',
        resolution: 'candidate',
        method: 'path-convention',
        reason: 'Path contains /composables/ convention',
      },
    };
  }

  if (normPath.includes('/hooks/')) {
    const isNext = eco?.hasNext;
    return {
      framework: isNext ? 'next' : 'react',
      version: isNext ? eco?.frameworks.next?.rawVersion : eco?.frameworks.react?.rawVersion,
      evidence: {
        basis: 'heuristic',
        resolution: 'candidate',
        method: 'path-convention',
        reason: 'Path contains /hooks/ convention',
      },
    };
  }

  // Safe fallback for TSX/JSX
  if (ext === '.tsx' || ext === '.jsx') {
    return {
      framework: 'react',
      evidence: {
        basis: 'heuristic',
        resolution: 'candidate',
        method: 'jsx-fallback',
        reason: 'Default candidate for unclassified JSX/TSX files',
      },
    };
  }

  return {
    framework: 'unknown',
    evidence: {
      basis: 'heuristic',
      resolution: 'unresolved',
      method: 'neutral-fallback',
      reason: 'No framework signatures matched',
    },
  };
}

/**
 * Backward compatibility wrapper returning legacy framework string or FrontendFramework.
 */
export function detectFramework(
  filePath: string,
  explicitContent?: string,
  explicitRootDir?: string
): FrontendFramework | 'vue-composable' {
  const result = detectFrameworkWithEvidence(filePath, explicitContent, explicitRootDir);
  return componentFramework(filePath, result.framework);
}

export function componentFramework(filePath: string, framework: FrontendFramework): FrontendFramework | 'vue-composable' {
  const normPath = filePath.replace(/\\/g, '/');
  const base = basename(filePath, extname(filePath));
  const isComposableName = /^use[A-Z0-9_]/.test(base);

  const isScriptModule = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'].includes(extname(filePath).toLowerCase());
  if (isScriptModule && (framework === 'vue' || framework === 'nuxt') && (isComposableName || normPath.includes('/composables/'))) {
    return 'vue-composable';
  }

  return framework;
}

