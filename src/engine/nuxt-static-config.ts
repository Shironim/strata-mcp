import ts from 'typescript';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readSourceFile } from './source-file';
import { staticPropertyName, unwrapExpression } from './parsers/ts-syntax';
import type { InputDependency } from '../types';

export const UNKNOWN = Symbol('unknown-config-value');
export type StaticValue = string | number | boolean | null | undefined | typeof UNKNOWN | StaticValue[] | StaticObject;
export interface StaticObject { kind: 'object'; values: Map<string, StaticValue>; unknownKeys: boolean }
export function isStaticObject(value: StaticValue): value is StaticObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function configField(value: StaticValue, key: string): StaticValue {
  if (!isStaticObject(value)) return value === undefined ? undefined : UNKNOWN;
  return value.values.has(key) ? value.values.get(key) : value.unknownKeys ? UNKNOWN : undefined;
}

export async function resolveStaticModule(from: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [base];
  if (/\.[cm]?jsx?$/.test(base)) candidates.unshift(base.replace(/\.[cm]?jsx?$/, '.ts'));
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(base)) candidates.push(...['.ts', '.js', '.mts', '.mjs', '.json', '/index.ts', '/index.js'].map(suffix => base + suffix));
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}

/** Syntax interpreter. Never imports or calls project JavaScript. */
export class NuxtStaticConfig {
  readonly dependencies = new Map<string, InputDependency>();
  readonly unresolved = new Set<string>();
  private modules = new Map<string, ts.SourceFile>();
  private active = new Set<string>();
  private steps = 0;

  async source(path: string): Promise<ts.SourceFile | undefined> {
    path = resolve(path);
    if (this.modules.has(path)) return this.modules.get(path);
    if (this.modules.size >= 256) { this.unresolved.add('config/export module limit reached'); return; }
    try {
      const content = await readSourceFile(path);
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
      this.modules.set(path, source);
      this.dependencies.set(path, { path, hash: createHash('sha256').update(content).digest('hex'), isExternal: true });
      return source;
    } catch { this.unresolved.add(`${path}: unreadable config/export module`); }
  }

  async exported(path: string, name = 'default'): Promise<StaticValue> {
    const source = await this.source(path);
    if (!source) return UNKNOWN;
    const identity = `${path}:${name}`;
    if (this.active.has(identity)) { this.unresolved.add(`${path}: cyclic config binding ${name}`); return UNKNOWN; }
    this.active.add(identity);
    try {
      if (path.endsWith('.json')) {
        const statement = source.statements[0];
        return statement && ts.isExpressionStatement(statement) ? await this.evaluate(statement.expression, source, 0) : UNKNOWN;
      }
      if (source.statements.some(statement => ts.isThrowStatement(statement) || ts.isExpressionStatement(statement)
        && !ts.isStringLiteral(statement.expression))) this.unresolved.add(`${path}: top-level runtime effects were not evaluated`);
      for (const statement of source.statements) {
        if (name === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) return await this.evaluate(statement.expression, source, 0);
        if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const binding = statement.exportClause.elements.find(item => item.name.text === name && !item.isTypeOnly);
          if (!binding) continue;
          const original = binding.propertyName?.text ?? binding.name.text;
          if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = await resolveStaticModule(path, statement.moduleSpecifier.text);
            return target ? await this.exported(target, original) : UNKNOWN;
          }
          return await this.binding(original, source, 0);
        }
        if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          if (statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name)) return await this.binding(name, source, 0);
        }
      }
      return UNKNOWN;
    } finally { this.active.delete(identity); }
  }

  private async binding(name: string, source: ts.SourceFile, depth: number): Promise<StaticValue> {
    const identity = `${source.fileName}:local:${name}`;
    if (this.active.has(identity)) return UNKNOWN;
    this.active.add(identity);
    try {
      // Statements with runtime effects can mutate a const object before it is exported.
      if (source.statements.some(statement => !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)
        && !ts.isExportAssignment(statement) && !ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement)
        && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement))) return UNKNOWN;
      let effectfulInitializer = false;
      function inspect(node: ts.Node): void {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isBinaryExpression(node)
          && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) effectfulInitializer = true;
        ts.forEachChild(node, inspect);
      }
      for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (declaration.initializer) inspect(declaration.initializer);
      }
      if (effectfulInitializer) return UNKNOWN;
      for (const statement of source.statements) {
        if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
          const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
          if (declaration) return declaration.initializer ? await this.evaluate(declaration.initializer, source, depth + 1) : UNKNOWN;
        }
        if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
          const clause = statement.importClause;
          let imported: string | undefined;
          if (clause?.name?.text === name) imported = 'default';
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            const binding = clause.namedBindings.elements.find(item => item.name.text === name && !item.isTypeOnly);
            if (binding) imported = binding.propertyName?.text ?? binding.name.text;
          }
          if (imported) {
            const path = await resolveStaticModule(source.fileName, statement.moduleSpecifier.text);
            return path ? await this.exported(path, imported) : UNKNOWN;
          }
        }
      }
      return UNKNOWN;
    } finally { this.active.delete(identity); }
  }

  private async evaluate(raw: ts.Expression, source: ts.SourceFile, depth: number): Promise<StaticValue> {
    if (depth > 40 || ++this.steps > 20000) { this.unresolved.add('static config evaluation limit reached'); return UNKNOWN; }
    const node = unwrapExpression(raw);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) return this.binding(node.text, source, depth + 1);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineNuxtConfig' && node.arguments.length === 1) {
      const shadowed = source.statements.some(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'defineNuxtConfig')
        || (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === 'defineNuxtConfig'
        || ts.isImportDeclaration(statement) && statement.importClause && (
          statement.importClause.name?.text === 'defineNuxtConfig'
          || statement.importClause.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)
            && statement.importClause.namedBindings.name.text === 'defineNuxtConfig'
          || statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
          && statement.importClause.namedBindings.elements.some(binding => binding.name.text === 'defineNuxtConfig'
            && (binding.isTypeOnly || statement.importClause!.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)
              || statement.moduleSpecifier.text !== 'nuxt/config' || (binding.propertyName?.text ?? binding.name.text) !== 'defineNuxtConfig'))));
      return shadowed ? UNKNOWN : this.evaluate(node.arguments[0], source, depth + 1);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: StaticValue[] = [];
      for (const element of node.elements) {
        const value = await this.evaluate(ts.isSpreadElement(element) ? element.expression : element, source, depth + 1);
        if (ts.isSpreadElement(element) && Array.isArray(value)) values.push(...value);
        else values.push(value);
      }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const object: StaticObject = { kind: 'object', values: new Map(), unknownKeys: false };
      for (const member of node.properties) {
        if (ts.isSpreadAssignment(member)) {
          const spread = await this.evaluate(member.expression, source, depth + 1);
          if (isStaticObject(spread)) {
            if (spread.unknownKeys) { for (const key of object.values.keys()) object.values.set(key, UNKNOWN); object.unknownKeys = true; }
            for (const [key, value] of spread.values) object.values.set(key, value);
            continue;
          }
        } else if (member.name && staticPropertyName(member.name) !== undefined) {
          const key = staticPropertyName(member.name)!;
          object.values.set(key, ts.isPropertyAssignment(member) ? await this.evaluate(member.initializer, source, depth + 1)
            : ts.isShorthandPropertyAssignment(member) ? await this.binding(member.name.text, source, depth + 1) : UNKNOWN);
          continue;
        }
        object.unknownKeys = true;
        for (const key of object.values.keys()) object.values.set(key, UNKNOWN);
      }
      return object;
    }
    if (ts.isPropertyAccessExpression(node)) return configField(await this.evaluate(node.expression, source, depth + 1), node.name.text);
    if (ts.isConditionalExpression(node)) {
      const condition = await this.evaluate(node.condition, source, depth + 1);
      if (typeof condition === 'boolean') return this.evaluate(condition ? node.whenTrue : node.whenFalse, source, depth + 1);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = await this.evaluate(node.left, source, depth + 1);
      const right = await this.evaluate(node.right, source, depth + 1);
      if (typeof left === 'string' && typeof right === 'string') return left + right;
    }
    return UNKNOWN;
  }
}
