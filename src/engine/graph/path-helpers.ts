import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { escapeRegExp } from '../patterns';
import { findProjectRoot } from '../path-resolver';
import type { AliasConfig } from '../resolver';

export { findProjectRoot };

export interface ExtractedImport {
  name: string;
  alias?: string;
  source: string;
  isDynamic: boolean;
}

export const STATIC_IMPORT_PATTERN = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/gm;
export const DEFAULT_IMPORT_CLAUSE_PATTERN = /^([A-Za-z0-9_$]+)(?:\s*,|\s*$)/;
export const NAMED_IMPORT_BLOCK_PATTERN = /\{([^}]+)\}/;
export const NAMED_IMPORT_ITEM_PATTERN = /^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/;
export const DYNAMIC_IMPORT_PATTERN =
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:defineAsyncComponent|lazy|dynamic)\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
export const INLINE_ASYNC_COMPONENT_PATTERN =
  /([A-Za-z0-9_$]+)\s*:\s*(?:defineAsyncComponent|lazy|dynamic)\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;

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

/**
 * Extracts local component imports (static and dynamic lazy imports) from source code.
 */
export function extractLocalImports(
  content: string,
  aliasConfig?: AliasConfig | null
): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  // 1. Static imports
  const staticImportMatches = content.matchAll(STATIC_IMPORT_PATTERN);

  for (const m of staticImportMatches) {
    const clause = m[1].trim();
    const source = m[2].trim();

    // Skip third-party packages (not relative, absolute, or a configured alias)
    const isLocal =
      source.startsWith('.') ||
      source.startsWith('/') ||
      (aliasConfig?.isAlias(source) ?? false);
    if (!isLocal) continue;

    // Default import: import ProductCard from './ProductCard.vue'
    const defaultMatch = clause.match(DEFAULT_IMPORT_CLAUSE_PATTERN);
    if (defaultMatch) {
      imports.push({
        name: defaultMatch[1],
        alias: undefined,
        source,
        isDynamic: false,
      });
    }

    // Named imports: import { BaseButton as ActionButton, StatusBadge } from './components'
    const namedBlockMatch = clause.match(NAMED_IMPORT_BLOCK_PATTERN);
    if (namedBlockMatch) {
      const items = namedBlockMatch[1].split(',');
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed.startsWith('type ')) continue;
        const asMatch = trimmed.match(NAMED_IMPORT_ITEM_PATTERN);
        if (asMatch) {
          imports.push({
            name: asMatch[1],
            alias: asMatch[2],
            source,
            isDynamic: false,
          });
        }
      }
    }
  }

  // 2. Dynamic lazy imports: defineAsyncComponent, React.lazy, dynamic(), import()
  const dynamicMatches = content.matchAll(DYNAMIC_IMPORT_PATTERN);

  for (const m of dynamicMatches) {
    const source = m[2].trim();
    const isLocal =
      source.startsWith('.') ||
      source.startsWith('/') ||
      (aliasConfig?.isAlias(source) ?? false);
    if (isLocal) {
      imports.push({
        name: m[1],
        alias: undefined,
        source,
        isDynamic: true,
      });
    }
  }

  const inlineDynamicMatches = content.matchAll(INLINE_ASYNC_COMPONENT_PATTERN);
  for (const m of inlineDynamicMatches) {
    const source = m[2].trim();
    const isLocal =
      source.startsWith('.') ||
      source.startsWith('/') ||
      (aliasConfig?.isAlias(source) ?? false);
    if (isLocal) {
      imports.push({
        name: m[1],
        alias: undefined,
        source,
        isDynamic: true,
      });
    }
  }

  return imports;
}
