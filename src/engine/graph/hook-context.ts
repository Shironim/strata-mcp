import ts from 'typescript';
import { basename, extname } from 'node:path';
import { readSourceFile } from '../source-file';
import { parseTypeScript } from '../source-parser';
import { loadAliasConfig } from '../resolver';
import type { AliasConfig } from '../resolver';
import { reactBindings } from '../parsers/react-bindings';
import { unwrapExpression } from '../parsers/ts-syntax';
import { resolveImportPath } from './path-helpers';
import { extractComponentContextNodes } from './context-analyzer';
import type { ContextDependencyNode } from '../../types';

type Module = { sf: ts.SourceFile; bindings: ReturnType<typeof reactBindings> };

/** Request-local summaries; imported hooks are read again on the next tree query. */
export function createHookContextAnalyzer(aliasConfig?: AliasConfig | null) {
  const modules = new Map<string, Promise<Module | null>>();
  let remainingSteps = 4096;
  async function module(path: string, content?: string): Promise<Module | null> {
    if (!modules.has(path)) {
      if (modules.size >= 256) return null;
      modules.set(path, (async () => {
        const sf = parseTypeScript(path, content ?? await readSourceFile(path), /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        return { sf, bindings: reactBindings(sf) };
      })().catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }));
    }
    return modules.get(path)!;
  }
  async function importedPath(path: string, source: string) {
    const aliases = aliasConfig ?? await loadAliasConfig(path);
    if (!source.startsWith('.') && !source.startsWith('/') && !aliases?.isAlias(source)) return null;
    return resolveImportPath(path, source, aliases);
  }
  async function exported(path: string, name: string, visited: Set<string>, depth: number): Promise<string[]> {
    const key = `${path}:${name}`;
    if (depth > 12 || visited.has(key) || --remainingSteps < 0) return [];
    const next = new Set(visited).add(key);
    const mod = await module(path);
    if (!mod) return [];
    for (const stmt of mod.sf.statements) {
      if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          const el = stmt.exportClause.elements.find(el => !el.isTypeOnly && el.name.text === name);
          if (el) {
            const original = el.propertyName ?? el.name;
            if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
              const target = await importedPath(path, stmt.moduleSpecifier.text);
              return target ? exported(target, original.text, next, depth + 1) : [];
            }
            if (ts.isIdentifier(original)) return local(path, mod, original, next, depth + 1);
          }
        } else if (!stmt.exportClause && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) && name !== 'default') {
          const target = await importedPath(path, stmt.moduleSpecifier.text);
          const keys = target ? await exported(target, name, next, depth + 1) : [];
          if (keys.length) return keys;
        }
      }
      const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      const isExport = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isExport && ts.isFunctionDeclaration(stmt) && (isDefault ? name === 'default' : stmt.name?.text === name)) {
        return body(path, mod, stmt, next, depth + 1);
      }
      if (isExport && ts.isVariableStatement(stmt)) for (const declaration of stmt.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return callable(path, mod, declaration, next, depth + 1);
      }
      if (name === 'default' && ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        return callable(path, mod, stmt.expression, next, depth + 1);
      }
    }
    return [];
  }
  async function local(path: string, mod: Module, expression: ts.Expression, visited: Set<string>, depth: number): Promise<string[]> {
    if (depth > 12 || --remainingSteps < 0) return [];
    const binding = mod.bindings.imported(expression);
    if (binding?.source && binding.imported) {
      const target = await importedPath(path, binding.source);
      return target ? exported(target, binding.imported, visited, depth + 1) : [];
    }
    if (ts.isIdentifier(expression)) {
      const declaration = mod.bindings.binding(expression)?.declaration;
      if (declaration) return callable(path, mod, declaration, visited, depth + 1);
    }
    return [];
  }
  async function callable(path: string, mod: Module, node: ts.Node, visited: Set<string>, depth: number): Promise<string[]> {
    if (ts.isVariableDeclaration(node) && node.initializer) node = unwrapExpression(node.initializer);
    if (ts.isIdentifier(node)) return local(path, mod, node, visited, depth + 1);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return body(path, mod, node, visited, depth + 1);
    return [];
  }
  async function body(path: string, mod: Module, fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction, visited: Set<string>, depth: number): Promise<string[]> {
    const key = `${path}:body:${fn.pos}`;
    if (!fn.body || depth > 12 || visited.has(key)) return [];
    const next = new Set(visited).add(key);
    const keys = new Set<string>();
    const calls: ts.CallExpression[] = [];
    function scan(node: ts.Node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, scan);
    }
    scan(fn.body);
    for (const call of calls) {
      const api = mod.bindings.api(call.expression);
      const arg = call.arguments[0];
      const contextArg = arg && unwrapExpression(arg);
      const importedContext = contextArg && mod.bindings.imported(contextArg);
      const isReactUseContext = api === 'use' && contextArg && (mod.bindings.isLocalContext(contextArg)
        || importedContext?.imported?.endsWith('Context'));
      if ((api === 'useContext' || isReactUseContext) && contextArg && (ts.isIdentifier(contextArg) || ts.isPropertyAccessExpression(contextArg))) {
        const name = importedContext?.imported ?? contextArg.getText(mod.sf);
        keys.add(name.endsWith('Context') ? name : `${name}Context`);
      } else if (isHook(mod, call.expression)) {
        for (const key of await local(path, mod, call.expression, next, depth + 1)) keys.add(key);
      }
    }
    return [...keys];
  }
  function isHook(mod: Module, expression: ts.Expression): boolean {
    const imported = mod.bindings.imported(expression);
    const name = imported?.imported && imported.imported !== 'default' ? imported.imported : ts.isIdentifier(expression) ? expression.text : '';
    return /^use[A-Z]/.test(name);
  }
  return async (path: string, content: string) => {
    const result = extractComponentContextNodes(path, content);
    if (!/\.[jt]sx?$/.test(extname(path))) return result;
    const mod = await module(path, content);
    if (!mod) return result;
    const calls: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && isHook(mod!, node.expression) && !mod!.bindings.api(node.expression)) calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(mod.sf);
    for (const call of calls) for (const key of await local(path, mod, call.expression, new Set(), 0)) {
      const line = mod.sf.getLineAndCharacterOfPosition(call.getStart(mod.sf)).line + 1;
      if (result.consumers.some(c => c.key === key && c.line === line)) continue;
      const consumer: ContextDependencyNode = { key, type: 'react-use-context', component: basename(path), filePath: path, line,
        evidence: { basis: 'derived', resolution: 'candidate', method: 'react-hook-wrapper',
          reason: `Context usage traced through ${call.expression.getText(mod.sf)}(); context keys are source syntax, not runtime object identity.` } };
      result.consumers.push(consumer);
    }
    return result;
  };
}
