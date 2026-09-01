import { existsSync, promises as fs, statSync } from 'node:fs';
import { basename, dirname, normalize, resolve } from 'node:path';
import { getCandidateNames } from './template';
import type {
  ComponentTreeNode,
  ComponentTreeOptions,
  ComponentTreeResult,
} from '../types';

import { Database } from 'bun:sqlite';

interface ExtractedImport {
  name: string;
  alias?: string;
  source: string;
  isDynamic: boolean;
}

/**
 * Resolves an import specifier to a physical file path.
 */
export function resolveImportPath(currentFile: string, importPath: string): string | null {
  const dir = dirname(currentFile);
  const target = resolve(dir, importPath);

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
 * Follows barrel file re-exports (e.g., export { default as BaseButton } from './BaseButton.vue').
 */
export function resolveBarrelExport(barrelFile: string, exportedName: string): string | null {
  if (!existsSync(barrelFile)) return null;

  try {
    const content = statSync(barrelFile).isFile() ? require('fs').readFileSync(barrelFile, 'utf8') : '';
    const regex = new RegExp(
      `export\\s*\\{[^}]*?\\b(?:default\\s+as\\s+)?${exportedName}\\b[^}]*?\\}\\s*from\\s*['"]([^'"]+)['"]`,
      'm'
    );
    const match = content.match(regex);
    if (match && match[1]) {
      return resolveImportPath(barrelFile, match[1]);
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Extracts local component imports (static and dynamic lazy imports) from source code.
 */
export function extractLocalImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  // 1. Static imports
  const staticImportMatches = content.matchAll(
    /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/gm
  );

  for (const m of staticImportMatches) {
    const clause = m[1].trim();
    const source = m[2].trim();

    // Skip third-party packages (not starting with . or /)
    if (!source.startsWith('.') && !source.startsWith('/')) continue;

    // Default import: import ProductCard from './ProductCard.vue'
    const defaultMatch = clause.match(/^([A-Za-z0-9_$]+)(?:\s*,|\s*$)/);
    if (defaultMatch) {
      imports.push({
        name: defaultMatch[1],
        alias: undefined,
        source,
        isDynamic: false,
      });
    }

    // Named imports: import { BaseButton as ActionButton, StatusBadge } from './components'
    const namedBlockMatch = clause.match(/\{([^}]+)\}/);
    if (namedBlockMatch) {
      const items = namedBlockMatch[1].split(',');
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed.startsWith('type ')) continue;
        const asMatch = trimmed.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
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
  const dynamicMatches = content.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:defineAsyncComponent|lazy|dynamic)\s*\(\s*(?:\(\)\s*=>\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g
  );

  for (const m of dynamicMatches) {
    const source = m[2].trim();
    if (source.startsWith('.') || source.startsWith('/')) {
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

/**
 * Checks if a component identifier or candidate alias is actually rendered in the file's template/JSX.
 */
export function isRenderedInContent(content: string, identifier: string): boolean {
  const candidates = getCandidateNames(identifier);
  for (const cand of candidates) {
    // Check template/JSX tag: <Tag or </Tag or :is="'Tag'" or is="Tag"
    const tagRegex = new RegExp(`<(?:[A-Za-z0-9_$.]+\\.)?${cand}[\\s/>]|:is=['"]${cand}['"]`);
    if (tagRegex.test(content)) return true;
  }
  return false;
}

/**
 * In-Memory SQLite Component Graph Database (Engine A).
 */
export class ComponentGraphDatabase {
  private db: Database;

  constructor() {
    this.db = new Database(':memory:');
    this.db.run(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE,
        name TEXT
      );
      CREATE TABLE links (
        parent_id INTEGER,
        child_id INTEGER,
        alias TEXT,
        is_dynamic INTEGER DEFAULT 0
      );
    `);
  }

  public recordFile(filePath: string): number {
    const norm = normalize(filePath);
    const existing = this.db.query('SELECT id FROM files WHERE path = ?').get(norm) as any;
    if (existing) return existing.id;

    const name = basename(filePath);
    const insert = this.db.prepare('INSERT INTO files (path, name) VALUES (?, ?)');
    insert.run(norm, name);
    const row = this.db.query('SELECT id FROM files WHERE path = ?').get(norm) as any;
    return row.id;
  }

  public recordLink(parentId: number, childId: number, alias?: string, isDynamic: boolean = false): void {
    const insert = this.db.prepare(
      'INSERT INTO links (parent_id, child_id, alias, is_dynamic) VALUES (?, ?, ?, ?)'
    );
    insert.run(parentId, childId, alias || null, isDynamic ? 1 : 0);
  }

  public close(): void {
    this.db.close();
  }
}

/**
 * Resolves the downward component hierarchy tree starting from a root page or layout.
 */
export async function getComponentTree(options: ComponentTreeOptions): Promise<ComponentTreeResult> {
  const entryPath = resolve(options.entryPath);
  if (!existsSync(entryPath)) {
    throw new Error(`Entry component file not found: ${entryPath}`);
  }

  const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 3;
  const graphDb = new ComponentGraphDatabase();
  const allComponents = new Set<string>();
  let maxDepthReached = 0;

  async function buildSubTree(
    filePath: string,
    depth: number,
    visitedInBranch: Set<string>
  ): Promise<ComponentTreeNode> {
    const normPath = normalize(filePath);
    const componentName = basename(filePath);
    allComponents.add(normPath);
    if (depth > maxDepthReached) maxDepthReached = depth;

    const parentId = graphDb.recordFile(normPath);
    visitedInBranch.add(normPath);

    const node: ComponentTreeNode = {
      component: componentName,
      filePath: normPath,
      depth,
      children: [],
    };

    if (depth >= maxDepth) return node;

    let content = '';
    try {
      content = await fs.readFile(normPath, 'utf8');
    } catch {
      return node;
    }

    const imports = extractLocalImports(content);

    for (const imp of imports) {
      let resolved = resolveImportPath(normPath, imp.source);
      if (!resolved) continue;

      // If resolved is a barrel file, follow the re-export to the underlying component
      if (
        resolved.endsWith('index.ts') ||
        resolved.endsWith('index.js') ||
        resolved.endsWith('index.tsx')
      ) {
        const barrelTarget = resolveBarrelExport(resolved, imp.name);
        if (barrelTarget) resolved = barrelTarget;
      }

      // Check if this component or its alias is actually rendered
      const renderId = imp.alias || imp.name;
      if (!isRenderedInContent(content, renderId)) {
        continue;
      }

      const childNorm = normalize(resolved);
      const childId = graphDb.recordFile(childNorm);
      graphDb.recordLink(parentId, childId, imp.alias, imp.isDynamic);

      // Prevent infinite loops on circular dependencies in the current branch
      if (!visitedInBranch.has(childNorm)) {
        const childNode = await buildSubTree(
          childNorm,
          depth + 1,
          new Set(visitedInBranch)
        );
        childNode.alias = imp.alias;
        childNode.isDynamic = imp.isDynamic;
        node.children.push(childNode);
      }
    }

    return node;
  }

  const rootNode = await buildSubTree(entryPath, 0, new Set());
  graphDb.close();

  return {
    root: rootNode,
    totalComponents: allComponents.size,
    maxDepthReached,
  };
}

/**
 * Formats a ComponentTreeResult into a human-readable ASCII indented tree.
 */
export function formatTreeAsText(result: ComponentTreeResult): string {
  function renderNode(
    node: ComponentTreeNode,
    prefix: string = '',
    isLast: boolean = true,
    isRoot: boolean = true
  ): string {
    let text = '';
    if (isRoot) {
      text += `${node.component} (Root Page)\n`;
    } else {
      const branch = isLast ? '└── ' : '├── ';
      let label = node.component;
      if (node.alias) label += ` (alias: ${node.alias})`;
      if (node.isDynamic) label += ` [dynamic/lazy]`;
      text += `${prefix}${branch}${label}\n`;
    }

    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isChildLast = i === node.children.length - 1;
      text += renderNode(child, childPrefix, isChildLast, false);
    }

    return text;
  }

  const treeText = renderNode(result.root);
  const summary = `\nSummary: ${result.totalComponents} components explored, max depth: ${result.maxDepthReached}`;
  return treeText + summary;
}
