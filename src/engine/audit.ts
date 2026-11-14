import { readSourceFile } from './source-file';
import { basename, extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import { getCandidateNames, toKebabCase } from './template';
import { detectFramework } from './contract';
import { escapeRegExp } from './patterns';
import { renderedComponentKeys } from './graph/downward-traversal';
import { extractLocalImports, resolveImportPath, resolveBarrelExport } from './graph/path-helpers';
import { loadAliasConfig } from './resolver';
import ts from 'typescript';
import { parseTypeScript } from './source-parser';
import { reactBindings } from './parsers/react-bindings';
import { scanDynamicImportsAndGlobals } from './dynamic-imports';
import type { UnusedComponentInfo, UnusedComponentsOptions, UnusedComponentsResult } from '../types';

/**
 * Checks if a file path matches a glob pattern (supports **, *, and ?; case-insensitive).
 */
export function matchesGlob(filePath: string, glob: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const normGlob = glob.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

  const tokens = normGlob.split(/(\/\*\*\/?|\*\*\/?|\*|\?)/);
  const regexStr = tokens
    .map((part) => {
      if (part === '/**/' || part === '/**' || part === '**/') return '(?:.*\\/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '.';
      return escapeRegExp(part);
    })
    .join('');

  const regex = new RegExp(`(?:^|/)${regexStr}(?:$|/)`);
  return regex.test(normPath);
}

/**
 * Determines whether a file path belongs to a page/route/view directory.
 */
export function isPagePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)(?:app|pages|views)\/(?:.*\/)?(?:partials|components?|_components?)\//.test(norm)) {
    return false;
  }
  return (
    norm.includes('/pages/') ||
    norm.includes('/views/') ||
    norm.includes('/routes/') ||
    norm.includes('/app/') ||
    norm.startsWith('pages/') ||
    norm.startsWith('views/') ||
    norm.startsWith('routes/') ||
    norm.startsWith('app/')
  );
}

/**
 * Audits a codebase to find dead or unreferenced components (0 usages).
 */
export async function findUnusedComponents(
  options: UnusedComponentsOptions
): Promise<UnusedComponentsResult> {
  const startTime = performance.now();
  const targetDir = resolve(options.targetPath);
  const absScope = options.scopePath ? resolve(targetDir, options.scopePath) : undefined;
  const allFiles = await collectFiles(targetDir, {
    excludeDirs: options.excludeDirs,
  });

  const defaultTestLayoutIgnores = [
    '**/layouts/**',
    '**/*.stories.*',
    '**/*.test.*',
    '**/*.spec.*',
  ];

  const defaultPageIgnores = [
    '**/pages/**',
    '**/views/**',
    '**/routes/**',
    '**/app/**',
  ];

  const excludePages = options.excludePages !== false;

  const hasCustomIgnore = Boolean(options.ignorePatterns && options.ignorePatterns.length > 0);
  const ignorePatterns = hasCustomIgnore
    ? options.ignorePatterns!
    : excludePages
      ? [...defaultPageIgnores, ...defaultTestLayoutIgnores]
      : defaultTestLayoutIgnores;

  function matchesAnyGlob(filePath: string, relPath: string, baseName: string, patterns: string[]): boolean {
    return patterns.some(
      (pat) => matchesGlob(relPath, pat) || matchesGlob(filePath, pat) || matchesGlob(baseName, pat)
    );
  }

  function shouldIgnore(filePath: string): boolean {
    const relPath = relative(targetDir, filePath).replace(/\\/g, '/');
    const baseName = basename(filePath);
    if (!hasCustomIgnore && excludePages && /(?:^|\/)app\/(?:.*\/)?(?:components?|_components?)\//i.test(relPath)) {
      return matchesAnyGlob(filePath, relPath, baseName, defaultTestLayoutIgnores);
    }
    return matchesAnyGlob(filePath, relPath, baseName, ignorePatterns);
  }

  // Pass 1: Collect component declarations (scoped to scopePath if provided)
  const declaredComponents: {
    name: string;
    fileName: string;
    filePath: string;
    framework: ReturnType<typeof detectFramework>;
    candidates: string[];
    isPage: boolean;
    usageCount: number;
  }[] = [];

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!['.vue', '.astro', '.svelte', '.tsx', '.jsx'].includes(ext)) continue;
    if (absScope) {
      const rel = relative(absScope, file);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
    }
    if (shouldIgnore(file)) continue;

    const base = basename(file, ext);
    const isPage = isPagePath(file);

    declaredComponents.push({
      name: base,
      fileName: basename(file),
      filePath: normalize(file),
      framework: detectFramework(file),
      candidates: getCandidateNames(base),
      isPage,
      usageCount: 0,
    });
  }

  // Pass 2: Collect all file contents in target path and evaluate references
  const fileContents: { file: string; content: string }[] = [];
  for (const file of allFiles) {
    const norm = normalize(file);
    try {
      const content = await readSourceFile(norm);
      fileContents.push({ file: norm, content });
    } catch {
      // ignore
    }
  }

  // Scan dynamic imports, Inertia glob resolvers, and global component registrations
  const dynamicRegistry = await scanDynamicImportsAndGlobals(targetDir, fileContents, allFiles);
  const referencedBy = new Map<string, Set<string>>();
  const renderedFiles = new Set<string>();
  for (const { file, content } of fileContents) {
    const renderedKeys = renderedComponentKeys(content);
    for (const key of renderedKeys) {
      let files = referencedBy.get(key);
      if (!files) referencedBy.set(key, files = new Set());
      files.add(file);
    }
    const aliases = await loadAliasConfig(file);
    const jsxImports = new Set<string>();
    const isJsx = /\.[jt]sx$/.test(file);
    if (isJsx) {
      const sf = parseTypeScript(file, content, ts.ScriptKind.TSX);
      const bindings = reactBindings(sf);
      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const binding = bindings.imported(node.tagName as ts.Expression);
          if (binding?.source) jsxImports.add(`${binding.source}\0${node.tagName.getText(sf)}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
    for (const imp of extractLocalImports(content, aliases, file)) {
      const local = imp.alias ?? imp.name;
      if (!renderedKeys.has(`case:${local.toLowerCase()}`)) continue;
      if (isJsx && !imp.isDynamic && !jsxImports.has(`${imp.source}\0${local}`)) continue;
      let target = resolveImportPath(file, imp.source, aliases);
      const visited = new Set<string>();
      while (target && !visited.has(target)) {
        visited.add(target);
        if (target !== file) renderedFiles.add(normalize(target));
        target = resolveBarrelExport(target, imp.name, aliases);
      }
    }
  }
  fileContents.length = 0;

  for (const comp of declaredComponents) {
    const normCompPath = normalize(comp.filePath);

    // Whitelist components matched by import.meta.glob, defineAsyncComponent, or registered globally
    if (
      dynamicRegistry.globMatchedFiles.has(normCompPath) ||
      renderedFiles.has(normCompPath) ||
      dynamicRegistry.globalComponents.has(comp.name.toLowerCase())
    ) {
      comp.usageCount++;
      continue;
    }

    comp.usageCount = comp.candidates.some(candidate =>
      [`case:${candidate.toLowerCase()}`, `kebab:${toKebabCase(candidate)}`].some(key => {
        const files = referencedBy.get(key);
        return files && (files.size > 1 || !files.has(normCompPath));
      })
    ) ? 1 : 0;
  }

  const unused = declaredComponents
    .filter((c) => c.usageCount === 0)
    .map((c): UnusedComponentInfo => ({
      name: c.name,
      fileName: c.fileName,
      filePath: c.filePath,
      framework: c.framework,
      isPage: c.isPage,
    }));

  const orphanComponents = unused.filter((c) => !c.isPage);
  const unreferencedPages = unused.filter((c) => c.isPage);

  // If excludePages is explicitly false, unusedComponents contains both. Otherwise, only pure reusable components.
  const finalUnused = excludePages ? orphanComponents : unused;

  const durationMs = Math.round(performance.now() - startTime);

  return {
    targetPath: targetDir,
    totalScanned: declaredComponents.length,
    unusedCount: finalUnused.length,
    unusedComponents: finalUnused,
    orphanComponents,
    unreferencedPages,
    _meta: {
      engine: 'in-memory-ast',
      durationMs,
    },
  };
}

/**
 * Formats UnusedComponentsResult into token-efficient, human-readable text.
 */
export function formatUnusedAsText(result: UnusedComponentsResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Unused Components Audit${metaBadge}`,
    `Target Path: ${result.targetPath}`,
    `Total Components Scanned: ${result.totalScanned}`,
    `Unused Components Found: ${result.unusedCount}`,
  ];

  const orphanCount = result.orphanComponents ? result.orphanComponents.length : result.unusedCount;
  const unreferencedPageCount = result.unreferencedPages ? result.unreferencedPages.length : 0;

  if (result.unusedCount === 0 && unreferencedPageCount === 0) {
    lines.push('');
    lines.push('Result: All scanned components are actively used across the project.');
    return lines.join('\n');
  }

  if (orphanCount > 0) {
    lines.push('');
    lines.push('Dead / Orphan Components (0 usages):');
    const list = result.orphanComponents || result.unusedComponents;
    for (const comp of list) {
      lines.push(`  - ${comp.fileName} (${comp.framework})`);
      lines.push(`    Path: ${comp.filePath}`);
    }
  }

  if (unreferencedPageCount > 0) {
    lines.push('');
    lines.push('Unreferenced Page Views (Direct Route / Controller Renderings):');
    for (const page of result.unreferencedPages || []) {
      lines.push(`  - ${page.fileName} (${page.framework}) [Page]`);
      lines.push(`    Path: ${page.filePath}`);
    }
  }

  return lines.join('\n');
}
