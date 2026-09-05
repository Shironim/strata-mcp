import { dirname, extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { getCandidateNames } from './template';
import { matchesGlob } from './audit';
import { loadAliasConfig, type AliasConfig } from './resolver';

export interface DiscoveredGlob {
  pattern: string;
  sourceFile: string;
}

export interface DiscoveredGlobalComponent {
  name: string;
  sourceFile: string;
  specifier?: string;
  resolvedPath?: string;
}

export interface DiscoveredAsyncComponent {
  name?: string;
  specifier: string;
  sourceFile: string;
  resolvedPath?: string;
}

export interface DynamicRegistry {
  globPatterns: DiscoveredGlob[];
  globMatchedFiles: Set<string>;
  globalComponents: Map<string, DiscoveredGlobalComponent>;
  asyncComponents: DiscoveredAsyncComponent[];
}

// Matches import.meta.glob('...') or import.meta.globEager('...') or array of globs
const IMPORT_META_GLOB_PATTERN =
  /import\.meta\.(?:glob|globEager)\s*(?:<[^>]+>)?\s*\(\s*(?:\[([\s\S]*?)\]|['"]([^'"]+)['"])/g;

// Matches defineAsyncComponent(() => import('...'))
const DEFINE_ASYNC_COMPONENT_PATTERN =
  /(?:(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*)?defineAsyncComponent\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;

// Matches app.component('Name', Component) or app.component('Name', () => import('...'))
const APP_COMPONENT_PATTERN =
  /(?:app|Vue)\.component\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*(?:(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z0-9_$]+))/g;

// Matches resolvePageComponent('./Pages/${name}.vue', import.meta.glob('./Pages/**/*.vue'))
const RESOLVE_PAGE_COMPONENT_PATTERN =
  /resolvePageComponent\s*\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*import\.meta\.glob/g;

/**
 * Parses raw glob string or array literal from import.meta.glob
 */
function extractGlobStrings(rawArg: string): string[] {
  const matches = rawArg.matchAll(/['"]([^'"]+)['"]/g);
  const patterns: string[] = [];
  for (const m of matches) {
    if (m[1] && m[1].trim()) {
      patterns.push(m[1].trim());
    }
  }
  return patterns;
}

/**
 * Resolves relative or aliased import specifiers against source file and alias config
 */
function resolveSpecifier(
  specifier: string,
  sourceFile: string,
  aliasConfig: AliasConfig | null,
  allFiles: string[]
): string | undefined {
  let candidate: string | null = null;

  if (aliasConfig && aliasConfig.isAlias(specifier)) {
    candidate = aliasConfig.resolve(specifier);
  } else if (specifier.startsWith('.')) {
    candidate = resolve(dirname(sourceFile), specifier);
  }

  if (!candidate) return undefined;

  const normalizedCandidate = normalize(candidate).toLowerCase();

  // Find matching file among collected files (handling optional extensions)
  for (const file of allFiles) {
    const normFile = normalize(file).toLowerCase();
    if (normFile === normalizedCandidate) return file;
    if (normFile.replace(/\.[a-z0-9]+$/i, '') === normalizedCandidate) return file;
  }

  return candidate;
}

/**
 * Matches a relative glob pattern from a source file against collected files in targetPath
 */
function matchGlobPattern(
  pattern: string,
  sourceFile: string,
  targetDir: string,
  allFiles: string[],
  aliasConfig: AliasConfig | null
): string[] {
  const matched: string[] = [];
  let baseFolder: string;
  let cleanPattern: string;

  if (aliasConfig && aliasConfig.isAlias(pattern)) {
    const resolvedBase = aliasConfig.resolve(pattern.replace(/\*.*$/, ''));
    baseFolder = resolvedBase ? normalize(resolvedBase) : targetDir;
    cleanPattern = pattern.replace(/^@[^/]*\/?/, '');
  } else if (pattern.startsWith('.')) {
    baseFolder = normalize(dirname(sourceFile));
    cleanPattern = pattern.replace(/^\.\//, '');
  } else {
    baseFolder = normalize(targetDir);
    cleanPattern = pattern;
  }

  for (const file of allFiles) {
    const normFile = normalize(file);
    const relFromBase = relative(baseFolder, normFile).replace(/\\/g, '/');
    const relFromTarget = relative(targetDir, normFile).replace(/\\/g, '/');

    if (
      matchesGlob(relFromBase, cleanPattern) ||
      matchesGlob(relFromTarget, cleanPattern) ||
      matchesGlob(normFile.replace(/\\/g, '/'), pattern)
    ) {
      matched.push(normFile);
    }
  }

  return matched;
}

/**
 * Scans codebase files for dynamic imports, Inertia resolvePageComponent,
 * import.meta.glob patterns, and global component registrations.
 */
export async function scanDynamicImportsAndGlobals(
  targetDir: string,
  fileContents: Array<{ file: string; content: string }>,
  allFiles: string[]
): Promise<DynamicRegistry> {
  const globPatterns: DiscoveredGlob[] = [];
  const globMatchedFiles = new Set<string>();
  const globalComponents = new Map<string, DiscoveredGlobalComponent>();
  const asyncComponents: DiscoveredAsyncComponent[] = [];

  let aliasConfig: AliasConfig | null = null;
  try {
    aliasConfig = await loadAliasConfig(targetDir);
  } catch {
    // Alias loading fallback
  }

  for (const { file, content } of fileContents) {
    // 1. Scan import.meta.glob
    for (const match of content.matchAll(IMPORT_META_GLOB_PATTERN)) {
      const rawArray = match[1];
      const singleGlob = match[2];

      const patterns = rawArray ? extractGlobStrings(rawArray) : singleGlob ? [singleGlob] : [];
      for (const pat of patterns) {
        globPatterns.push({ pattern: pat, sourceFile: file });
        const matched = matchGlobPattern(pat, file, targetDir, allFiles, aliasConfig);
        for (const m of matched) {
          globMatchedFiles.add(normalize(m));
        }
      }
    }

    // 2. Scan Inertia resolvePageComponent pattern fallback
    for (const match of content.matchAll(RESOLVE_PAGE_COMPONENT_PATTERN)) {
      const pageTemplate = match[1]; // e.g. "./Pages/${name}.vue"
      const globEquivalent = pageTemplate.replace(/\$\{[^}]+\}/g, '**/*');
      globPatterns.push({ pattern: globEquivalent, sourceFile: file });
      const matched = matchGlobPattern(globEquivalent, file, targetDir, allFiles, aliasConfig);
      for (const m of matched) {
        globMatchedFiles.add(normalize(m));
      }
    }

    // 3. Scan defineAsyncComponent
    for (const match of content.matchAll(DEFINE_ASYNC_COMPONENT_PATTERN)) {
      const compName = match[1];
      const specifier = match[2];
      const resolved = resolveSpecifier(specifier, file, aliasConfig, allFiles);
      asyncComponents.push({
        name: compName,
        specifier,
        sourceFile: file,
        resolvedPath: resolved,
      });
      if (resolved) {
        globMatchedFiles.add(normalize(resolved));
      }
    }

    // 4. Scan app.component('Name', Target)
    for (const match of content.matchAll(APP_COMPONENT_PATTERN)) {
      const compName = match[1];
      const asyncSpecifier = match[2];
      const staticIdent = match[3];

      let resolvedPath: string | undefined;
      let specifier: string | undefined;

      if (asyncSpecifier) {
        specifier = asyncSpecifier;
        resolvedPath = resolveSpecifier(asyncSpecifier, file, aliasConfig, allFiles);
      } else if (staticIdent) {
        // Find import of staticIdent within current file content
        const importRegex = new RegExp(
          `import\\s+(?:${staticIdent}|\\{[^}]*\\b${staticIdent}\\b[^}]*\\})\\s+from\\s+['"]([^'"]+)['"]`
        );
        const importMatch = content.match(importRegex);
        if (importMatch) {
          specifier = importMatch[1];
          resolvedPath = resolveSpecifier(specifier, file, aliasConfig, allFiles);
        }
      }

      const discovered: DiscoveredGlobalComponent = {
        name: compName,
        sourceFile: file,
        specifier,
        resolvedPath,
      };

      globalComponents.set(compName.toLowerCase(), discovered);
      for (const cand of getCandidateNames(compName)) {
        globalComponents.set(cand.toLowerCase(), discovered);
      }

      if (resolvedPath) {
        globMatchedFiles.add(normalize(resolvedPath));
      }
    }
  }

  return {
    globPatterns,
    globMatchedFiles,
    globalComponents,
    asyncComponents,
  };
}
