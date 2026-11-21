import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript';
import { defaultPluginRegistry } from '../../../plugins';
import { canonicalizePath } from '../../path-resolver';
import {
  resolveRelativeModuleFile,
  resolveWorkspacePackageImport,
  type WorkspacePackageInfo,
} from '../workspace-packages';
import {
  isVirtualTsxPath,
  stripVirtualTsxSuffix,
  type VirtualFileRegistry,
} from './virtual-registry';

const AMBIENT_MACROS_FILENAME = '__strata_framework_macros__.d.ts';
const AMBIENT_MACROS_CONTENT = `
declare function defineProps<T = Record<string, any>>(): T;
declare function defineProps<T extends Record<string, any>>(props: T): T;
declare function withDefaults<T, D extends Partial<T>>(props: T, defaults: D): T;
declare function defineEmits<T = (...args: any[]) => void>(): T;
declare function defineModel<T = any>(name?: string, options?: Record<string, any>): { value: T };
declare function defineSlots<T = Record<string, any>>(): T;
declare function defineExpose<T = Record<string, any>>(exposed?: T): void;
declare function definePageMeta(meta: Record<string, any>): void;
declare function defineNuxtConfig(config: Record<string, any>): Record<string, any>;
declare function $props<T = Record<string, any>>(): T;
declare function $state<T>(initial: T): T;
declare function $derived<T>(value: T): T;
declare function $effect(fn: () => void | (() => void)): void;
declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
`;

const SFC_EXTENSIONS = new Set(['.vue', '.svelte', '.astro']);

function collectPackageSourceFiles(packageRoot: string, maxFiles = 4000): string[] {
  const supported = defaultPluginRegistry.supportedExtensions();
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.strata', '.next', '.output', 'coverage']);

  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(entry)) continue;
      // Allow .nuxt/*.d.ts for Nuxt auto-imports & global components
      if (entry.startsWith('.') && entry !== '.nuxt') continue;

      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (supported.has(ext) || entry.endsWith('.d.ts')) {
          out.push(canonicalizePath(full));
        }
      }
    }
  };

  walk(packageRoot);
  return out;
}

function loadCompilerOptions(pkg: WorkspacePackageInfo): {
  options: ts.CompilerOptions;
  configRootFiles: string[];
} {
  const baseOverrides: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowJs: true,
    allowNonTsExtensions: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  };

  if (pkg.tsconfigPath && existsSync(pkg.tsconfigPath)) {
    const readRes = ts.readConfigFile(pkg.tsconfigPath, ts.sys.readFile);
    if (!readRes.error && readRes.config) {
      const parsed = ts.parseJsonConfigFileContent(
        readRes.config,
        ts.sys,
        dirname(pkg.tsconfigPath),
        baseOverrides,
        pkg.tsconfigPath
      );
      return {
        options: {
          ...parsed.options,
          ...baseOverrides,
          // Keep user's moduleResolution if set, otherwise Bundler
          moduleResolution: parsed.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
          target: parsed.options.target ?? ts.ScriptTarget.ESNext,
          module: parsed.options.module ?? ts.ModuleKind.ESNext,
        },
        configRootFiles: parsed.fileNames.map((f) => canonicalizePath(f)),
      };
    }
  }

  // Synthetic compilerOptions fallback for pure-JS / config-less legacy packages
  return {
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      checkJs: false,
      ...baseOverrides,
    },
    configRootFiles: [],
  };
}

export interface CreateLanguageHostParams {
  pkg: WorkspacePackageInfo;
  allPackages: readonly WorkspacePackageInfo[];
  virtualRegistry: VirtualFileRegistry;
}

export function createStrataLanguageServiceHost(params: CreateLanguageHostParams): {
  host: ts.LanguageServiceHost;
  compilerOptions: ts.CompilerOptions;
  ambientMacrosPath: string;
} {
  const { pkg, allPackages, virtualRegistry } = params;
  const { options: compilerOptions, configRootFiles } = loadCompilerOptions(pkg);
  const ambientMacrosPath = join(pkg.rootPath, AMBIENT_MACROS_FILENAME);

  const hasVueRuntimeTypes = existsSync(join(pkg.rootPath, 'node_modules', '@vue', 'runtime-core'));

  // Build initial root script file names, projecting SFCs to their virtualPath
  const rawFiles = new Set<string>(configRootFiles);
  for (const discovered of collectPackageSourceFiles(pkg.rootPath)) {
    rawFiles.add(discovered);
  }

  const rootScriptNames = new Set<string>();
  if (!hasVueRuntimeTypes) {
    rootScriptNames.add(ambientMacrosPath);
  }

  for (const file of rawFiles) {
    if (file.endsWith('.d.ts')) {
      rootScriptNames.add(file);
      continue;
    }
    const ext = extname(file).toLowerCase();
    if (SFC_EXTENSIONS.has(ext)) {
      const projected = virtualRegistry.getForOriginal(file);
      if (projected) rootScriptNames.add(projected.doc.virtualPath);
    } else {
      rootScriptNames.add(file);
    }
  }

  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => {
      if (fileName === ambientMacrosPath) return true;
      if (isVirtualTsxPath(fileName)) return existsSync(stripVirtualTsxSuffix(fileName));
      return ts.sys.fileExists(fileName);
    },
    readFile: (fileName) => {
      if (fileName === ambientMacrosPath) return AMBIENT_MACROS_CONTENT;
      if (isVirtualTsxPath(fileName)) {
        return virtualRegistry.getForVirtual(fileName)?.doc.virtualCode;
      }
      return ts.sys.readFile(fileName);
    },
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => pkg.rootPath,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };

  const toResolvedModule = (targetFile: string): ts.ResolvedModuleFull => {
    const ext = extname(targetFile).toLowerCase();
    if (SFC_EXTENSIONS.has(ext)) {
      const projected = virtualRegistry.getForOriginal(targetFile);
      if (projected) {
        return {
          resolvedFileName: projected.doc.virtualPath,
          extension: ts.Extension.Tsx,
          isExternalLibraryImport: false,
        };
      }
    }
    const tsExt =
      ext === '.tsx'
        ? ts.Extension.Tsx
        : ext === '.jsx'
          ? ts.Extension.Jsx
          : ext === '.js' || ext === '.mjs' || ext === '.cjs'
            ? ts.Extension.Js
            : targetFile.endsWith('.d.ts')
              ? ts.Extension.Dts
              : ts.Extension.Ts;
    return {
      resolvedFileName: targetFile,
      extension: tsExt,
      isExternalLibraryImport: targetFile.includes('node_modules'),
    };
  };

  const resolveSingleModule = (specifier: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    const realContaining = virtualRegistry.resolveOriginalPath(containingFile);

    // 1. Direct relative resolution (handles .vue/.svelte/.astro & extensionless imports)
    if (specifier.startsWith('.')) {
      const rel = resolveRelativeModuleFile(realContaining, specifier);
      if (rel) return toResolvedModule(rel);
    }

    // 2. Monorepo workspace package resolution (directly to source files, even if dist/ is unbuilt)
    const wsTarget = resolveWorkspacePackageImport(specifier, allPackages);
    if (wsTarget) return toResolvedModule(wsTarget);

    // 3. Standard TypeScript module resolution (tsconfig paths, node_modules, etc.)
    const std = ts.resolveModuleName(specifier, realContaining, compilerOptions, moduleResolutionHost);
    if (std.resolvedModule) {
      const resolved = std.resolvedModule;
      const ext = extname(resolved.resolvedFileName).toLowerCase();
      if (SFC_EXTENSIONS.has(ext)) {
        return toResolvedModule(resolved.resolvedFileName);
      }
      return resolved;
    }

    // 4. Fallback for tsconfig paths pointing to SFC files without .ts extension
    if (compilerOptions.paths) {
      const base = compilerOptions.baseUrl ? resolve(pkg.rootPath, compilerOptions.baseUrl) : pkg.rootPath;
      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (pattern.endsWith('/*')) {
          const prefix = pattern.slice(0, -1);
          if (specifier.startsWith(prefix)) {
            const rest = specifier.slice(prefix.length);
            for (const t of targets) {
              const candidate = resolve(base, t.replace(/\*$/, '') + rest);
              if (existsSync(candidate) && statSync(candidate).isFile()) {
                return toResolvedModule(canonicalizePath(candidate));
              }
            }
          }
        } else if (pattern === specifier) {
          for (const t of targets) {
            const candidate = resolve(base, t);
            if (existsSync(candidate) && statSync(candidate).isFile()) {
              return toResolvedModule(canonicalizePath(candidate));
            }
          }
        }
      }
    }

    return undefined;
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => pkg.rootPath,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    getScriptFileNames: () => [...rootScriptNames],
    getScriptVersion: (fileName) => {
      if (fileName === ambientMacrosPath) return '1';
      if (isVirtualTsxPath(fileName)) {
        return virtualRegistry.getForVirtual(fileName)?.doc.sourceHash ?? '0';
      }
      try {
        const st = statSync(fileName);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '0';
      }
    },
    getScriptSnapshot: (fileName) => {
      if (fileName === ambientMacrosPath) {
        return ts.ScriptSnapshot.fromString(AMBIENT_MACROS_CONTENT);
      }
      if (isVirtualTsxPath(fileName)) {
        const entry = virtualRegistry.getForVirtual(fileName);
        return entry ? ts.ScriptSnapshot.fromString(entry.doc.virtualCode) : undefined;
      }
      if (!existsSync(fileName)) return undefined;
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    fileExists: moduleResolutionHost.fileExists,
    readFile: moduleResolutionHost.readFile,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    resolveModuleNameLiterals: (moduleLiterals, containingFile) => {
      return moduleLiterals.map((lit) => ({
        resolvedModule: resolveSingleModule(lit.text, containingFile),
      }));
    },
  };

  return { host, compilerOptions, ambientMacrosPath };
}
