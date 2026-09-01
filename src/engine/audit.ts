import { promises as fs } from 'node:fs';
import { basename, extname, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import { getCandidateNames } from './template';
import { detectFramework } from './contract';
import { escapeRegExp } from './patterns';
import type {
  UnusedComponentInfo,
  UnusedComponentsOptions,
  UnusedComponentsResult,
} from '../types';

/**
 * Checks if a file path matches a glob pattern (supports **, *, and ?).
 */
export function matchesGlob(filePath: string, glob: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normGlob = glob.replace(/\\/g, '/').replace(/^\.\//, '');

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
  const targetDir = resolve(options.targetPath);
  const allFiles = await collectFiles(targetDir);

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
    framework: 'vue' | 'react' | 'astro' | 'unknown';
    candidates: string[];
    usageCount: number;
  }[] = [];

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!['.vue', '.astro', '.tsx', '.jsx'].includes(ext)) continue;
    if (shouldIgnore(file)) continue;

    const base = basename(file, ext);
    declaredComponents.push({
      name: base,
      fileName: basename(file),
      filePath: normalize(file),
      framework: detectFramework(file),
      candidates: getCandidateNames(base),
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

  for (const comp of declaredComponents) {
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
    }));

  return {
    targetPath: targetDir,
    totalScanned: declaredComponents.length,
    unusedCount: unused.length,
    unusedComponents: unused,
  };
}

/**
 * Formats UnusedComponentsResult into token-efficient, human-readable text.
 */
export function formatUnusedAsText(result: UnusedComponentsResult): string {
  const lines: string[] = [
    'Unused Components Audit',
    `Target Path: ${result.targetPath}`,
    `Total Components Scanned: ${result.totalScanned}`,
    `Unused Components Found: ${result.unusedCount}`,
  ];

  if (result.unusedCount === 0) {
    lines.push('');
    lines.push('Result: All scanned components are actively used across the project.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Dead / Orphan Components (0 usages):');
  for (const comp of result.unusedComponents) {
    lines.push(`  - ${comp.fileName} (${comp.framework})`);
    lines.push(`    Path: ${comp.filePath}`);
  }

  return lines.join('\n');
}
