import ts from 'typescript';
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { NuxtStaticConfig, UNKNOWN, configField, isStaticObject, resolveStaticModule, type StaticValue } from './nuxt-static-config';
import type { InputDependency } from '../types';

const CONFIG_NAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts', 'nuxt.config.json', 'nuxt.config.cjs', 'nuxt.config.cts'];

interface LayerConfig {
  root: string;
  sourceDir: string;
  autoImport?: boolean | typeof UNKNOWN;
  scan?: boolean | typeof UNKNOWN;
  dirs: string[];
  extends: string[];
}

export interface NuxtAutoImportDiscovery {
  enabled: boolean;
  names: Set<string>;
  configFiles: string[];
  unresolved: string[];
  dependencies: InputDependency[];
}

async function readLayer(root: string, result: NuxtAutoImportDiscovery, reader: NuxtStaticConfig, configFile?: string): Promise<LayerConfig> {
  const layer: LayerConfig = { root, sourceDir: root, dirs: [], extends: [] };
  function strings(expression: StaticValue, field: string): string[] {
    if (expression === undefined || expression === null) return [];
    const values = Array.isArray(expression) ? expression : [expression];
    const strings: string[] = [];
    for (const value of values) {
      if (typeof value === 'string') strings.push(value);
      else result.unresolved.push(`${root}: dynamic ${field}`);
    }
    return strings;
  }
  for (const path of configFile ? [configFile] : CONFIG_NAMES.map(name => join(root, name))) {
    try { if (!(await fs.stat(path)).isFile()) continue; } catch { continue; }
    result.configFiles.push(path);
    const expression = await reader.exported(path);
    if (!isStaticObject(expression)) {
      result.unresolved.push(`${root}: dynamic config`);
      layer.autoImport = layer.scan = UNKNOWN;
      break;
    }
    if (expression.unknownKeys) result.unresolved.push(`${root}: dynamic config keys or spread`);
    const imports = configField(expression, 'imports');
    if (isStaticObject(imports)) {
      if (imports.unknownKeys) result.unresolved.push(`${root}: dynamic imports keys or spread`);
      for (const key of ['autoImport', 'scan'] as const) {
        const value = configField(imports, key);
        if (typeof value === 'boolean') layer[key] = value;
        else if (value !== undefined && value !== null) {
          layer[key] = UNKNOWN;
          result.unresolved.push(`${root}: dynamic imports.${key}`);
        }
      }
      layer.dirs = strings(configField(imports, 'dirs'), 'imports.dirs');
      for (const key of ['presets', 'imports', 'transform', 'addons', 'polyfills']) {
        if (configField(imports, key) !== undefined) result.unresolved.push(`${root}: imports.${key} requires runtime/config resolution`);
      }
    } else if (imports) {
      layer.autoImport = layer.scan = UNKNOWN;
      result.unresolved.push(`${root}: dynamic imports`);
    }
    const dir = configField(expression, 'srcDir');
    if (typeof dir === 'string') layer.sourceDir = resolve(root, dir);
    else if (dir) result.unresolved.push(`${root}: dynamic srcDir`);
    layer.extends = strings(configField(expression, 'extends'), 'extends');
    for (const key of ['$env', '$development', '$production', 'hooks', 'modules', 'alias', 'rootDir']) {
      if (configField(expression, key) !== undefined) result.unresolved.push(`${root}: ${key} requires runtime/config resolution`);
    }
    break;
  }
  return layer;
}

/** Candidate discovery only: local literal config, without executing Nuxt modules. */
export async function discoverNuxtAutoImports(root: string): Promise<NuxtAutoImportDiscovery> {
  root = resolve(root);
  const reader = new NuxtStaticConfig();
  const result: NuxtAutoImportDiscovery = { enabled: true, names: new Set(), configFiles: [], unresolved: [], dependencies: [] };
  function finish(): NuxtAutoImportDiscovery {
    result.unresolved = [...new Set([...result.unresolved, ...reader.unresolved])];
    result.dependencies = [...reader.dependencies.values()].map(dependency => {
      const path = relative(root, dependency.path);
      return { ...dependency, isExternal: path === '..' || path.startsWith('../') || isAbsolute(path) };
    });
    return result;
  }
  const layers: LayerConfig[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  async function layerTarget(target: string, from: string): Promise<string | null> {
    if (/^(?:gh|github|gitlab|bitbucket):|^https?:\/\//.test(target)) {
      result.unresolved.push(`${from}: remote layer requires materialized local/package source (unsupported layer download)`);
      return null;
    }
    if (/^(?:~~|@@|~|@)\//.test(target)) return resolve(root, target.replace(/^(?:~~|@@|~|@)\//, ''));
    if (target.startsWith('.') || isAbsolute(target)) return resolve(from, target);
    const match = target.match(/^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/(.*))?$/);
    if (!match || target.includes(':')) { result.unresolved.push(`${from}: unsupported layer ${target}`); return null; }
    let directory = from;
    while (true) {
      const packageRoot = join(directory, 'node_modules', match[1]);
      const packageJson = join(packageRoot, 'package.json');
      try {
        if ((await fs.stat(packageJson)).isFile()) {
          const source = await reader.source(packageJson);
          const pkg = source ? JSON.parse(source.text) : {};
          try { return Bun.resolveSync(target, from); } catch {}
          if (pkg.exports !== undefined) { result.unresolved.push(`${from}: package layer export cannot be resolved ${target}`); return null; }
          return match[2] ? resolve(packageRoot, match[2]) : packageRoot;
        }
      } catch { /* Missing or invalid package metadata leaves this resolution unverified. */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    result.unresolved.push(`${from}: missing installed package layer ${target}`);
    return null;
  }
  async function visit(directory: string, isRoot = false): Promise<void> {
    let canonical: string;
    let configFile: string | undefined;
    try { canonical = await fs.realpath(directory); } catch {
      result.unresolved.push(`${directory}: missing layer`);
      return;
    }
    if ((await fs.stat(canonical)).isFile()) { configFile = canonical; canonical = dirname(canonical); }
    if (!configFile) {
      for (const name of CONFIG_NAMES) {
        const path = join(canonical, name);
        try { if ((await fs.stat(path)).isFile()) { configFile = await fs.realpath(path); break; } } catch {}
      }
    }
    const identity = configFile ?? canonical;
    if (active.has(identity)) { result.unresolved.push(`${canonical}: cyclic extends`); return; }
    if (visited.has(identity)) return;
    if (visited.size >= 64) {
      result.unresolved.push('layer limit reached');
      return;
    }
    visited.add(identity);
    active.add(identity);
    const layer = await readLayer(canonical, result, reader, configFile);
    layers.push(layer);
    if (isRoot) {
      let entries: string[] = [];
      try { entries = await fs.readdir(join(root, 'layers')); } catch {}
      const automatic: string[] = [];
      for (const entry of entries.sort().reverse()) {
        const path = join(root, 'layers', entry);
        try { if ((await fs.stat(path)).isDirectory()) automatic.push(await fs.realpath(path)); } catch {}
      }
      // Explicit references to auto-scanned layers retain their listed order.
      for (const target of layer.extends) {
        if (!target.startsWith('.') && !isAbsolute(target) && !/^(?:~~|@@|~|@)\//.test(target)) continue;
        const path = await layerTarget(target, canonical);
        try { if (path && automatic.includes(await fs.realpath(path))) await visit(path); } catch {}
      }
      for (const path of automatic) await visit(path);
    }
    for (const target of layer.extends) {
      const path = await layerTarget(target, canonical);
      if (path) await visit(path);
    }
    active.delete(identity);
  }
  await visit(root, true);
  result.enabled = layers.find(layer => layer.autoImport !== undefined)?.autoImport !== false;
  const scan = layers.find(layer => layer.scan !== undefined)?.scan !== false;
  if (!result.enabled || !scan) return finish();
  const files = new Set<string>();
  async function collect(directory: string, recursive: boolean, depth = 0): Promise<void> {
    if (depth > 16 || files.size >= 4096) {
      result.unresolved.push(`${directory}: scan limit reached`);
      return;
    }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && recursive) await collect(path, true, depth + 1);
      else if (entry.isFile() && /\.(?:ts|js|mts|mjs)$/.test(entry.name) && !/\.d\.(?:ts|mts)$/.test(entry.name)) {
        if (files.size >= 4096) { result.unresolved.push(`${directory}: scan limit reached`); break; }
        files.add(path);
      }
    }
  }
  for (const layer of layers) {
    if (layer.scan === false) continue;
    for (const directory of ['composables', 'utils', 'app/composables', 'app/utils']) await collect(join(layer.sourceDir, directory), false);
    for (const directory of layer.dirs) {
      const recursive = directory.endsWith('/**');
      let path = recursive ? directory.slice(0, -3) : directory;
      // Global aliases refer to the application, including when used by a layer.
      const app = layers[0];
      if (/^[~@]\//.test(path)) path = resolve(app.sourceDir, path.slice(2));
      else if (/^(~~|@@)\//.test(path)) path = resolve(app.root, path.slice(3));
      else path = resolve(layer.sourceDir, path);
      if (/[*?{}[\]]/.test(path)) {
        try {
          // Bun's filesystem glob handles brace, character-class and globstar patterns.
          let count = 0;
          for await (const match of new Bun.Glob(path).scan({ cwd: '/', absolute: true, onlyFiles: false, followSymlinks: false })) {
            if (++count > 4096) { result.unresolved.push(`${layer.root}: glob match limit reached`); break; }
            const stat = await fs.lstat(match);
            if (stat.isDirectory()) await collect(match, recursive);
            else if (stat.isFile() && /\.(?:ts|js|mts|mjs)$/.test(match) && !/\.d\.(?:ts|mts)$/.test(match)) {
              if (files.size >= 4096) { result.unresolved.push(`${layer.root}: scan limit reached`); break; }
              files.add(match);
            }
          }
        } catch { result.unresolved.push(`${layer.root}: invalid or unreadable imports.dirs pattern ${directory}`); }
      } else await collect(path, recursive);
    }
  }
  const exportActive = new Set<string>();
  let exportVisits = 0;
  async function exportsOf(path: string): Promise<Set<string>> {
    const names = new Set<string>();
    if (++exportVisits > 4096 || exportActive.size >= 40) { result.unresolved.push('export traversal limit reached'); return names; }
    const source = await reader.source(path);
    if (!source) return names;
    if (exportActive.has(path)) { result.unresolved.push(`${path}: cyclic export closure`); return names; }
    exportActive.add(path);
    const typeOnly = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) typeOnly.add(statement.name.text);
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.isTypeOnly && clause.name) typeOnly.add(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const binding of clause.namedBindings.elements) if (clause.isTypeOnly || binding.isTypeOnly) typeOnly.add(binding.name.text);
        }
      }
    }
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        let targetNames: Set<string> | undefined;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const target = await resolveStaticModule(path, statement.moduleSpecifier.text);
          if (target) targetNames = await exportsOf(target);
          else result.unresolved.push(`${path}: unresolved export dependency ${statement.moduleSpecifier.text}`);
        }
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements) {
            const original = item.propertyName?.text ?? item.name.text;
            if (!item.isTypeOnly && (statement.moduleSpecifier ? targetNames?.has(original) : !typeOnly.has(original))) names.add(item.name.text);
          }
        } else if (!statement.exportClause && targetNames) {
          for (const name of targetNames) if (name !== 'default') names.add(name);
        }
      }
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) names.add('default');
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        if (!ts.isInterfaceDeclaration(statement)) names.add('default');
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        if (statement.name) names.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
          else result.unresolved.push(`${path}: destructured export requires binding resolution`);
        }
      }
    }
    exportActive.delete(path);
    return names;
  }
  for (const path of files) {
    for (const name of await exportsOf(path)) result.names.add(name === 'default' ? basename(path, extname(path)) : name);
  }
  return finish();
}
