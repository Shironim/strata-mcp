import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Evidence, FrontendFramework } from '../types';
import { findProjectRoot } from './path-resolver';

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
  const ext = extname(filePath).toLowerCase();

  let rootDir = explicitRootDir;
  if (!rootDir) {
    try {
      rootDir = findProjectRoot(filePath);
    } catch {
      rootDir = process.cwd();
    }
  }

  const eco = rootDir ? getProjectEcosystem(rootDir) : undefined;

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
    // 2a. SolidJS check (Prohibit misclassifying Solid as React)
    const hasSolidImports =
      /\bfrom\s+['"](?:solid-js|solid-js\/(?:web|store|html))['"]/.test(content);
    const hasSolidPragma =
      /\/\*[\s*]*@jsxImportSource\s+solid-js/.test(content);
    const hasSolidSignals =
      /\b(?:createSignal|createEffect|createMemo|createResource|createStore)\s*\(/.test(content);

    // 2b. Next.js check
    const hasNextDirective =
      /^(?:['"]use client['"]|['"]use server['"])/m.test(content);
    const hasNextImports =
      /\bfrom\s+['"](?:next\/[^'"]+|@next\/[^'"]+)['"]/.test(content);

    // 2c. Nuxt check
    const hasNuxtImports =
      /\bfrom\s+['"](?:#app|#imports|#components|nuxt\/[^'"]+)['"]/.test(content);
    const hasNuxtMacros =
      /\b(?:definePageMeta|useAsyncData|useFetch|defineNuxtComponent|defineNuxtRouteMiddleware)\s*\(/.test(content);

    // 2d. React check
    const hasReactImports =
      /\bfrom\s+['"](?:react|react-dom|react\/[^'"]+|@tanstack\/react-query)['"]/.test(content);
    const hasReactHooks =
      /\b(?:useState|useEffect|useCallback|useMemo|useRef|useContext|useReducer|useTransition|useId)\s*\(/.test(content);

    // 2e. Vue check
    const hasVueImports =
      /\bfrom\s+['"](?:vue|@vue\/[^'"]+|@vueuse\/[^'"]+|pinia|@inertiajs\/vue3|vue-router)['"]/.test(content);
    const hasVueReactivity =
      /\b(?:ref|reactive|computed|watch|watchEffect|shallowRef|toRef|toRefs|inject|provide)\s*\(/.test(content);

    // Evaluation precedence:
    if (hasSolidImports || hasSolidPragma || (hasSolidSignals && !hasReactImports && !hasReactHooks)) {
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

    if (hasNextDirective || hasNextImports) {
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
          reason: hasNextDirective ? 'Next.js directive ("use client" / "use server")' : 'Import from next/*',
        },
      };
    }

    if (hasNuxtImports || hasNuxtMacros) {
      const nuxtInfo = eco?.frameworks.nuxt;
      return {
        framework: 'nuxt',
        version: nuxtInfo?.rawVersion,
        majorVersion: nuxtInfo?.major,
        minorVersion: nuxtInfo?.minor,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'ast-import-signature',
          reason: hasNuxtImports ? 'Nuxt virtual alias import (#app/#imports)' : 'Nuxt compiler macro (e.g. definePageMeta)',
        },
      };
    }

    if (hasReactImports || hasReactHooks) {
      const isNextProject = eco?.hasNext;
      const fw: FrontendFramework = isNextProject ? 'next' : 'react';
      const info = isNextProject ? eco?.frameworks.next : eco?.frameworks.react;
      return {
        framework: fw,
        version: info?.rawVersion,
        majorVersion: info?.major,
        minorVersion: info?.minor,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'ast-import-signature',
          reason: 'React module import or standard hook call',
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
          basis: 'source',
          resolution: 'resolved',
          method: 'ast-import-signature',
          reason: 'Vue module import or Composition API reactivity call',
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
  explicitContent?: string
): FrontendFramework | 'vue-composable' {
  const result = detectFrameworkWithEvidence(filePath, explicitContent);
  const normPath = filePath.replace(/\\/g, '/');
  const base = basename(filePath, extname(filePath));
  const isComposableName = /^use[A-Z0-9_]/.test(base);

  if ((result.framework === 'vue' || result.framework === 'nuxt') && (isComposableName || normPath.includes('/composables/'))) {
    return 'vue-composable';
  }

  return result.framework;
}

