import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { escapeRegExp } from '../patterns';
import { findProjectRoot } from '../path-resolver';
import type { AliasConfig } from '../resolver';
import type { ExtractedImport } from '../../types';
import ts from 'typescript';
import { createDocumentAdapter } from '../../adapters/factory';

export { findProjectRoot };
export type { ExtractedImport };

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
 * Extracts runtime import bindings, including namespace members and lazy factories.
 */
export function extractImports(
  content: string,
  filePath?: string
): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const inferredPath = filePath ?? (/^\s*---/.test(content) ? 'file.astro' : /^\s*<(?:script|template)\b/.test(content) ? 'file.vue' : 'file.tsx');
  const code = createDocumentAdapter(inferredPath, content).getScriptBlocks().map(b => b.content).join('\n');
  const sf = ts.createSourceFile('file.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const namespaces = new Map<string, string>();
  const add = (name: string, source: string, isDynamic: boolean, alias?: string) => {
    if (!imports.some(i => i.name === name && i.alias === alias && i.source === source)) {
      imports.push({ name, source, isDynamic, alias });
    }
  };
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause || stmt.importClause.isTypeOnly) continue;
    const source = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause.name) add(clause.name.text, source, false);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (!el.isTypeOnly) add(el.propertyName?.text ?? el.name.text, source, false, el.propertyName ? el.name.text : undefined);
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.set(clause.namedBindings.name.text, source);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const source = namespaces.get(node.expression.text);
      if (source) add(node.name.text, source, false, node.getText(sf));
    }
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      const factory = call.expression.getText(sf);
      if (['defineAsyncComponent', 'lazy', 'React.lazy', 'dynamic'].includes(factory)) {
        let body: ts.Node | undefined = call.arguments[0];
        if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) body = body.body;
        if (body && ts.isBlock(body)) body = body.statements.find(ts.isReturnStatement)?.expression;
        if (body && ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword && body.arguments[0] && ts.isStringLiteralLike(body.arguments[0])) {
          if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) add(node.name.text, body.arguments[0].text, true);
        }
      }
    }
    // Universal dynamic import expression resolution: () => import(...), await import(...), etc.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      const arg = node.arguments[0];
      const inferName = (fallbackSource: string): string => {
        let current: ts.Node = node;
        while (current.parent) {
          current = current.parent;
          if (ts.isPropertyAssignment(current)) {
            const propName = ts.isIdentifier(current.name) || ts.isStringLiteral(current.name) ? current.name.text : '';
            if (propName && propName !== 'component' && propName !== 'default') return propName;
            return basename(fallbackSource, extname(fallbackSource));
          } else if (ts.isArrayLiteralExpression(current)) {
            return basename(fallbackSource, extname(fallbackSource));
          } else if (ts.isVariableDeclaration(current)) {
            if (ts.isIdentifier(current.name)) return current.name.text;
          }
        }
        return basename(fallbackSource, extname(fallbackSource));
      };

      if (ts.isStringLiteralLike(arg)) {
        const source = arg.text;
        let current: ts.Node = node;
        let boundNames: string[] = [];
        while (current.parent) {
          current = current.parent;
          if (ts.isVariableDeclaration(current) && ts.isObjectBindingPattern(current.name)) {
            boundNames = current.name.elements
              .map((el) => (ts.isIdentifier(el.name) ? el.name.text : ''))
              .filter(Boolean);
            break;
          }
        }
        if (boundNames.length > 0) {
          for (const bName of boundNames) {
            add(bName, source, true);
          }
        } else {
          const name = inferName(source);
          add(name, source, true);
        }
      } else if (ts.isTemplateExpression(arg) && filePath) {
        const head = arg.head.text;
        const lastSpan = arg.templateSpans[arg.templateSpans.length - 1];
        const suffix = lastSpan ? lastSpan.literal.text : '';
        const baseDir = resolve(dirname(filePath), head);
        if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
          try {
            const entries = readdirSync(baseDir);
            for (const entry of entries) {
              if (suffix ? entry.endsWith(suffix) : /\.(vue|tsx|jsx|ts|js|svelte|astro)$/.test(entry)) {
                const compName = basename(entry, extname(entry));
                const resolvedSource = `${head.endsWith('/') ? head : head + '/'}${entry}`;
                add(compName, resolvedSource, true);
              }
            }
          } catch {
            // ignore read error
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return imports;
}

/** Keeps the public local-import contract; all bindings are available for shadow checks. */
export function extractLocalImports(content: string, aliasConfig?: AliasConfig | null, filePath?: string): ExtractedImport[] {
  return extractImports(content, filePath).filter(i => i.source.startsWith('.') || i.source.startsWith('/') || aliasConfig?.isAlias(i.source));
}
