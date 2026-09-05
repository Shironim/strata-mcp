import { promises as fs } from 'node:fs';
import { basename, extname, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import { getCandidateNames } from './template';
import { detectFramework } from './contract';
import { escapeRegExp } from './patterns';
import { scanDynamicImportsAndGlobals } from './dynamic-imports';
import type {
  UnusedComponentInfo,
  UnusedComponentsOptions,
  UnusedComponentsResult,
} from '../types';

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
 * Checks whether a component candidate name appears in file content.
 */
function isComponentReferencedInContent(content: string, candidateNames: string[]): boolean {
  for (const cand of candidateNames) {
    const escaped = escapeRegExp(cand);
    const regex = new RegExp(`\\b${escaped}\\b|<${escaped}[\\s/>]|['"].*?${escaped}(?:\\.[a-z0-9]+)?['"]`);
    if (regex.test(content)) return true;
  }
  return false;
}

/**
 * Audits a codebase to find dead or unreferenced components (0 usages).
 */
export async function findUnusedComponents(
  options: UnusedComponentsOptions
): Promise<UnusedComponentsResult> {
  const startTime = performance.now();
  const targetDir = resolve(options.targetPath);
  const allFiles = await collectFiles(targetDir, {
    excludeDirs: options.excludeDirs,
  });

  const defaultIgnores = [
    '**/pages/**',
    '**/views/**',
    '**/routes/**',
    '**/app/**',
    '**/*.stories.*',
    '**/*.test.*',
    '**/*.spec.*',
  ];

  const ignorePatterns = options.ignorePatterns && options.ignorePatterns.length > 0
    ? options.ignorePatterns
    : defaultIgnores;

  function shouldIgnore(filePath: string): boolean {
    const relPath = relative(targetDir, filePath);
    const baseName = basename(filePath);

    for (const pat of ignorePatterns) {
      if (
        matchesGlob(relPath, pat) ||
        matchesGlob(filePath, pat) ||
        matchesGlob(baseName, pat)
      ) {
        return true;
      }
    }
    return false;
  }

  // Pass 1: Collect component declarations
  const declaredComponents: {
    name: string;
    fileName: string;
    filePath: string;
    framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable';
    candidates: string[];
    isPage: boolean;
    usageCount: number;
  }[] = [];

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!['.vue', '.astro', '.tsx', '.jsx'].includes(ext)) continue;
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
      const content = await fs.readFile(norm, 'utf8');
      fileContents.push({ file: norm, content });
    } catch {
      // ignore
    }
  }

  // Scan dynamic imports, Inertia glob resolvers, and global component registrations
  const dynamicRegistry = await scanDynamicImportsAndGlobals(targetDir, fileContents, allFiles);

  for (const comp of declaredComponents) {
    const normCompPath = normalize(comp.filePath);

    // Whitelist components matched by import.meta.glob, defineAsyncComponent, or registered globally
    if (
      dynamicRegistry.globMatchedFiles.has(normCompPath) ||
      dynamicRegistry.globalComponents.has(comp.name.toLowerCase())
    ) {
      comp.usageCount++;
      continue;
    }

    for (const { file, content } of fileContents) {
      if (file === comp.filePath) continue; // skip self references
      if (isComponentReferencedInContent(content, comp.candidates)) {
        comp.usageCount++;
        break; // Once referenced, no need to keep searching for this component
      }
    }
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
  const excludePages = options.excludePages !== false;
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
