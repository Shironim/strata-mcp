import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findProjectRoot } from "../path-resolver";
import type { AliasConfig } from "../resolver";
import { escapeRegExp } from "../patterns";
import {
  type ExtractedImport,
  STATIC_IMPORT_PATTERN,
  DEFAULT_IMPORT_CLAUSE_PATTERN,
  NAMED_IMPORT_BLOCK_PATTERN,
  NAMED_IMPORT_ITEM_PATTERN,
  DYNAMIC_IMPORT_PATTERN,
  INLINE_ASYNC_COMPONENT_PATTERN,
} from "./ast-helpers";

export { findProjectRoot };

/**
 * Checks if a file path is a page or route file based on common framework conventions.
 */
export function isPageFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return (
    norm.includes('/pages/') ||
    norm.includes('/Pages/') ||
    norm.includes('/views/') ||
    norm.includes('/Views/') ||
    norm.includes('/routes/') ||
    (norm.includes('/app/') &&
      (norm.endsWith('/page.tsx') ||
        norm.endsWith('/page.jsx') ||
        norm.endsWith('/page.vue') ||
        norm.endsWith('/page.js')))
  );
}

/**
 * Resolves an import specifier to a physical file path.
 */
export function resolveImportPath(
  currentFile: string,
  importPath: string,
  aliasConfig?: AliasConfig | null
): string | null {
  const dir = dirname(currentFile);

  let target: string;
  if (aliasConfig && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    const mapped = aliasConfig.resolve(importPath);
    if (!mapped) return null;
    target = mapped;
  } else {
    target = resolve(dir, importPath);
  }

  const extensions = ['', '.vue', '.tsx', '.jsx', '.astro', '.ts', '.js'];
  for (const ext of extensions) {
    const candidate = target + ext;
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }

  // Check directory index files
  for (const ext of ['.vue', '.tsx', '.jsx', '.astro', '.ts', '.js']) {
    const indexCandidate = resolve(target, 'index' + ext);
    if (existsSync(indexCandidate)) {
      try {
        if (statSync(indexCandidate).isFile()) return indexCandidate;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Finds the re-export source path for a named export inside a barrel file,
 * e.g. `export { default as BaseButton } from './BaseButton.vue'`.
 */
export function findBarrelReexportTarget(content: string, exportedName: string): string | null {
  const pattern = new RegExp(
    `export\\s*\\{[^}]*?\\b(?:default\\s+as\\s+)?${escapeRegExp(exportedName)}\\b[^}]*?\\}\\s*from\\s*['"]([^'"]+)['"]`,
    'm'
  );
  return content.match(pattern)?.[1] ?? null;
}

/**
 * Follows barrel file re-exports (e.g., export { default as BaseButton } from './BaseButton.vue').
 */
export function resolveBarrelExport(
  barrelFile: string,
  exportedName: string,
  aliasConfig?: AliasConfig | null
): string | null {
  if (!existsSync(barrelFile)) return null;

  try {
    const content = statSync(barrelFile).isFile() ? readFileSync(barrelFile, 'utf8') : '';
    const target = findBarrelReexportTarget(content, exportedName);
    return target ? resolveImportPath(barrelFile, target, aliasConfig) : null;
  } catch {
    // ignore
  }

  return null;
}

export { extractLocalImports } from './path-helpers';
