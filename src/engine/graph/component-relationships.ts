import { basename, extname } from 'node:path';
import ts from 'typescript';
import type { ExtractedImport } from '../../types';
import { canonicalizePath } from '../path-resolver';
import { reactBindings } from '../parsers/react-bindings';
import type { AliasConfig } from '../resolver';
import { parseTypeScript } from '../source-parser';
import { getCandidateNames, isComponentNameMatch } from '../template';
import { isSameMonorepoBoundary, resolveBarrelExport, resolveImportPath } from './path-helpers';

export const isJsxComponentFile = (file: string): boolean => /\.[jt]sx$/i.test(file);
export const isComponentCandidate = (file: string): boolean => /\.(vue|astro|svelte|tsx|jsx)$/i.test(file);

export function resolveComponentImport(file: string, source: string, name: string, aliases: AliasConfig | null) {
  if (!source.startsWith('.') && !source.startsWith('/') && !aliases?.isAlias(source)) {
    return { target: null, barrel: null };
  }
  const path = resolveImportPath(file, source, aliases);
  const barrel = path && /[/\\]index\.[tj]sx?$/.test(path) ? path : null;
  const target = (barrel && resolveBarrelExport(barrel, name, aliases)) || path;
  return { target: target ? canonicalizePath(target) : null, barrel: barrel ? canonicalizePath(barrel) : null };
}

export function collectJsxComponentUses(file: string, content: string, aliases: AliasConfig | null) {
  const ast = parseTypeScript(file, content, ts.ScriptKind.TSX);
  const bindings = reactBindings(ast);
  const uses = new Map<number, { tag: string; target: string | null; source?: string; bound: boolean }>();
  const resolved = new Map<string, string | null>();
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagNode = node.tagName;
      const tag = tagNode.getText(ast);
      const intrinsic = ts.isIdentifier(tagNode) && /^[a-z]/.test(tag);
      const imported = intrinsic ? undefined : bindings.imported(tagNode as ts.Expression);
      let target: string | null = null;
      if (imported?.source && imported.imported) {
        const key = JSON.stringify([imported.source, imported.imported]);
        if (!resolved.has(key)) resolved.set(key, resolveComponentImport(file, imported.source, imported.imported, aliases).target);
        target = resolved.get(key) ?? null;
      }
      let identifier: ts.Node = tagNode;
      while (ts.isPropertyAccessExpression(identifier)) identifier = identifier.expression;
      const bound = Boolean(intrinsic || imported || (ts.isIdentifier(identifier) && bindings.binding(identifier)));
      uses.set(node.getStart(ast), { tag, target, source: imported?.source, bound });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return uses;
}

/** Literal JSX sites override name-only render evidence. Factory patterns keep their existing coverage. */
export function jsxImportSites(
  uses: ReturnType<typeof collectJsxComponentUses> | undefined, imp: ExtractedImport, target: string | null,
): Set<number> | undefined {
  if (!uses || imp.isDynamic) return;
  const tag = imp.alias || imp.name;
  let seen = false;
  const matched = new Set<number>();
  for (const [start, use] of uses) {
    if (!isComponentNameMatch(use.tag, tag)) continue;
    seen = true;
    if (use.tag === tag && use.source === imp.source && use.target === target) matched.add(start);
  }
  return seen ? matched : undefined;
}

export function buildAutoComponentCatalog(files: Iterable<string>): Map<string, Set<string>> {
  const catalog = new Map<string, Set<string>>();
  for (const file of files) {
    if (!isComponentCandidate(file)) continue;
    const path = canonicalizePath(file);
    for (const name of getCandidateNames(basename(file, extname(file)))) {
      const key = name.toLowerCase();
      let candidates = catalog.get(key);
      if (!candidates) catalog.set(key, candidates = new Set());
      candidates.add(path);
    }
  }
  return catalog;
}

export function autoComponentCandidates(
  file: string, tag: string, imports: ExtractedImport[], catalog: ReturnType<typeof buildAutoComponentCatalog>,
): string[] {
  if (!/\.(vue|astro|svelte)$/i.test(file) || imports.some(imp => isComponentNameMatch(tag, imp.alias || imp.name))) return [];
  return [...(catalog.get(tag.toLowerCase()) ?? [])].filter(candidate =>
    candidate !== file && isSameMonorepoBoundary(file, candidate));
}
