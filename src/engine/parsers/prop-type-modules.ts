import ts from 'typescript';
import { isAbsolute, relative, resolve } from 'node:path';
import { readSourceSnapshot } from '../source-file';
import { loadAliasConfigWithDependencies } from '../resolver';
import { resolveImportPath } from '../graph/path-helpers';
import type { InputDependency } from '../../types';
import type { PropTypeOwner } from './local-prop-types';

interface Module {
  sf: ts.SourceFile;
  declaredTypes: PropTypeOwner['declaredTypes'];
  imports: Map<string, { path: string; name: string }>;
  exports: Map<string, { path?: string; name: string }>;
  stars: string[];
}

/** Bounded syntax-only module graph; bare package specifiers are not resolved. */
export class PropTypeModules {
  readonly dependencies = new Map<string, InputDependency>();
  readonly diagnostics = new Set<string>();
  private modules = new Map<string, Module>();
  private lookupVisits = 0;
  constructor(private root: string) {}

  async prepare(sf: ts.SourceFile, depth = 0): Promise<void> {
    const path = resolve(sf.fileName);
    if (this.modules.has(path)) return;
    if (this.modules.size >= 64 || depth > 24) { this.diagnostics.add('Prop type module graph limit reached.'); return; }
    const module: Module = { sf, declaredTypes: new Map(), imports: new Map(), exports: new Map(), stars: [] };
    this.modules.set(path, module);
    const { config, configFiles } = await loadAliasConfigWithDependencies(path);
    for (const file of configFiles) await this.capture(file);
    const targets = new Set<string>();
    const target = (specifier: string): string | undefined => {
      if (!specifier.startsWith('.') && !isAbsolute(specifier) && !config?.isAlias(specifier)) return;
      const found = /\.[cm]?jsx?$/.test(specifier)
        ? resolveImportPath(path, specifier.replace(/\.[cm]?jsx?$/, '.ts'), config) ?? resolveImportPath(path, specifier, config)
        : resolveImportPath(path, specifier, config);
      if (!found || !/\.[cm]?tsx?$/.test(found)) return;
      targets.add(resolve(found));
      return resolve(found);
    };
    for (const statement of sf.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        module.declaredTypes.set(statement.name.text, statement);
        if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          module.exports.set(statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name.text, { name: statement.name.text });
        }
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
        const imported = target(statement.moduleSpecifier.text);
        if (!imported) continue;
        const clause = statement.importClause;
        if (clause.name) module.imports.set(clause.name.text, { path: imported, name: 'default' });
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) module.imports.set(clause.namedBindings.name.text, { path: imported, name: '*' });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements) {
          module.imports.set(binding.name.text, { path: imported, name: binding.propertyName?.text ?? binding.name.text });
        }
      }
      if (ts.isExportDeclaration(statement)) {
        const imported = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? target(statement.moduleSpecifier.text) : undefined;
        if (statement.moduleSpecifier && !imported) this.diagnostics.add(`${path}: type re-export dependency could not be resolved.`);
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const binding of statement.exportClause.elements) module.exports.set(binding.name.text, {
            name: binding.propertyName?.text ?? binding.name.text,
            ...(statement.moduleSpecifier ? { path: imported ?? '' } : {}),
          });
        } else if (!statement.exportClause && imported) module.stars.push(imported);
      }
    }
    for (const file of targets) {
      if (this.modules.has(file)) continue;
      const snapshot = await this.capture(file);
      if (snapshot) await this.prepare(ts.createSourceFile(file, snapshot.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), depth + 1);
    }
  }

  private async capture(path: string) {
    try {
      const snapshot = await readSourceSnapshot(path);
      const rel = relative(this.root, path);
      const previous = this.dependencies.get(path);
      if (previous && previous.hash !== snapshot.snapshot.sha256) this.diagnostics.add(`${path}: prop type dependency changed during traversal.`);
      else this.dependencies.set(path, { path, hash: snapshot.snapshot.sha256, isExternal: rel === '..' || rel.startsWith('../') || isAbsolute(rel) });
      return snapshot;
    } catch { this.diagnostics.add(`${path}: prop type dependency could not be read.`); }
  }

  lookup = (sf: ts.SourceFile, name: string): PropTypeOwner | undefined => {
    this.lookupVisits = 0;
    const module = this.modules.get(resolve(sf.fileName));
    if (!module) return;
    const [local, ...members] = name.split('.');
    const imported = module.imports.get(local);
    if (!imported) return;
    if (members.length && imported.name !== '*') return;
    return this.exported(imported.path, imported.name === '*' ? members.join('.') : imported.name, new Set());
  };

  private exported(path: string, name: string, visited: Set<string>): PropTypeOwner | undefined {
    if (++this.lookupVisits > 4096) { this.diagnostics.add('Prop type symbol traversal limit reached.'); return; }
    const identity = `${path}:${name}`;
    if (visited.has(identity)) return;
    visited = new Set([...visited, identity]);
    const module = this.modules.get(path);
    if (!module) return;
    const exported = module.exports.get(name);
    if (exported) {
      if (exported.path !== undefined) return this.exported(exported.path, exported.name, visited);
      const declaration = module.declaredTypes.get(exported.name);
      if (declaration) return { sf: module.sf, declaredTypes: module.declaredTypes, declaration };
      const imported = module.imports.get(exported.name);
      if (imported) return this.exported(imported.path, imported.name, visited);
      return;
    }
    const candidates = module.stars.map(source => this.exported(source, name, visited)).filter((item): item is PropTypeOwner => !!item);
    const unique = new Map(candidates.map(item => [`${item.sf.fileName}:${item.declaration.name.text}`, item]));
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  }
}
