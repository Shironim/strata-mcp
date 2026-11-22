import { basename, dirname, extname, relative } from 'node:path';
import ts from 'typescript';
import { defaultPluginRegistry, hashSourceContent, type VirtualDocument } from '../../plugins';
import { assertSafeOffset, lineStarts, positionFromLineStarts } from '../../utils/source-position';
import {
  resolvePackageAliasImport,
  resolveRelativeModuleFile,
  resolveWorkspacePackageImport,
  type WorkspacePackageInfo,
} from './workspace-packages';

export type ExtractedSymbolKind =
  | 'component'
  | 'function'
  | 'class'
  | 'method'
  | 'composable'
  | 'store'
  | 'context'
  | 'type'
  | 'interface'
  | 'enum'
  | 'variable'
  | 'prop'
  | 'emit'
  | 'slot'
  | 'model';

export interface ExtractedSymbol {
  symbolUid: string;
  name: string;
  kind: ExtractedSymbolKind;
  parentSymbolUid?: string;
  isExported: boolean;
  isDefault: boolean;
  signature: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  meta?: Record<string, unknown>;
}

export type ExtractedEdgeKind =
  | 'imports'
  | 'reexports'
  | 'renders'
  | 'calls'
  | 'reads_state'
  | 'writes_state'
  | 'watches_state'
  | 'passes_prop'
  | 'listens_event'
  | 'provides_context'
  | 'consumes_context'
  | 'extends_type'
  | 'outbound_http'
  | 'submits_form';

export interface ExtractedEdge {
  sourceSymbolUid?: string;
  targetFilePath?: string;
  targetName: string;
  edgeKind: ExtractedEdgeKind;
  isDynamic: boolean;
  confidence: 'syntax' | 'semantic' | 'heuristic';
  lineNumber: number;
  startOffset: number;
  endOffset: number;
  payload?: Record<string, unknown>;
}

export interface Tier1ExtractionResult {
  filePath: string;
  relPath: string;
  framework: string;
  contentHash: string;
  isPage: boolean;
  isLayout: boolean;
  renderBoundary: string;
  boundaryDirective?: string;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  omissionsCount: number;
  contractSummary: Record<string, unknown>;
}

function hasExportModifier(node: ts.Node): { isExported: boolean; isDefault: boolean } {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods) return { isExported: false, isDefault: false };
  let isExported = false;
  let isDefault = false;
  for (const m of mods) {
    if (m.kind === ts.SyntaxKind.ExportKeyword) isExported = true;
    if (m.kind === ts.SyntaxKind.DefaultKeyword) isDefault = true;
  }
  return { isExported, isDefault };
}

const NON_COMPONENT_UPPER_NAMES = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'PROPFIND', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK',
]);

function classifyCallableKind(name: string, isJsxFile: boolean): ExtractedSymbolKind {
  if (/^use[A-Z][A-Za-z0-9_$]*Store$/.test(name)) return 'store';
  if (/^use[A-Z][A-Za-z0-9_$]*$/.test(name)) return 'composable';
  if (
    isJsxFile &&
    !NON_COMPONENT_UPPER_NAMES.has(name) &&
    !/^[A-Z0-9_]+$/.test(name) &&
    /^[A-Z][A-Za-z0-9_$]*$/.test(name)
  ) {
    return 'component';
  }
  return 'function';
}

function compactSignature(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf);
  const bodyIdx = text.indexOf('{');
  const head = bodyIdx > 0 ? text.slice(0, bodyIdx).trim() : text.split('\n')[0].trim();
  return head.replace(/\s+/g, ' ').slice(0, 180);
}

function isPageOrLayoutPath(relPath: string): { isPage: boolean; isLayout: boolean } {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const base = basename(norm);
  const isLayout =
    base.startsWith('layout.') ||
    norm.includes('/layouts/') ||
    norm.startsWith('layouts/');
  const isPage =
    !isLayout &&
    (norm.startsWith('pages/') ||
      norm.includes('/pages/') ||
      norm.startsWith('src/pages/') ||
      norm.startsWith('views/') ||
      norm.includes('/views/') ||
      /^app\/(?:.+\/)?page\.[a-z]+$/.test(norm) ||
      /^src\/app\/(?:.+\/)?page\.[a-z]+$/.test(norm) ||
      /\+page\.svelte$/.test(norm));
  return { isPage, isLayout };
}

function posFromStarts(rawContent: string, rawLineStarts: number[], offset: number) {
  assertSafeOffset(rawContent, offset);
  return positionFromLineStarts(rawLineStarts, offset);
}

function mapToOriginal(
  doc: VirtualDocument,
  rawContent: string,
  rawLineStarts: number[],
  virtStart: number,
  virtEnd: number
): { startOffset: number; endOffset: number; startLine: number; endLine: number } {
  const mapped = doc.toOriginalSpan(virtStart, virtEnd);
  const startOffset = mapped ? mapped.start : 0;
  const endOffset = mapped ? mapped.end : startOffset;
  const startPos = posFromStarts(rawContent, rawLineStarts, startOffset);
  const endPos = posFromStarts(rawContent, rawLineStarts, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: startPos.line,
    endLine: Math.max(startPos.line, endPos.line),
  };
}

/**
 * Single-pass fast Tier-1 extractor that converts any supported frontend file
 * into normalized symbols and edges using the FrameworkPlugin VirtualDocument.
 */
export function extractTier1File(
  filePath: string,
  rawContent: string,
  pkg: WorkspacePackageInfo,
  allPackages: readonly WorkspacePackageInfo[],
  precomputedHash?: string,
  importCache?: Map<string, string | undefined>,
  knownFiles?: ReadonlySet<string>
): Tier1ExtractionResult | null {
  const plugin = defaultPluginRegistry.resolveForFile(filePath);
  if (!plugin) return null;

  const contentHash = precomputedHash ?? hashSourceContent(rawContent);
  const doc = plugin.projectToVirtualTs(filePath, rawContent, contentHash);
  const facts = plugin.extractTier1Facts(doc, rawContent);
  const rawLineStarts = lineStarts(rawContent);
  const relPath = relative(pkg.rootPath, filePath).replace(/\\/g, '/');
  const fullKeyPrefix = `${pkg.packageKey}/${relPath}`;
  const ext = extname(filePath).toLowerCase();
  const isSfc = ext === '.vue' || ext === '.svelte' || ext === '.astro';
  const isJsxFile = ext === '.tsx' || ext === '.jsx';

  const sf =
    doc.isIdentity && facts.sourceFile
      ? facts.sourceFile
      : ts.createSourceFile(
          doc.virtualPath,
          doc.virtualCode,
          ts.ScriptTarget.Latest,
          false,
          ts.ScriptKind.TSX
        );

  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const uidCounter = new Map<string, number>();

  const nextUid = (kind: ExtractedSymbolKind, name: string): string => {
    const base = `${fullKeyPrefix}#${kind}:${name}`;
    const count = uidCounter.get(base) ?? 0;
    uidCounter.set(base, count + 1);
    return count === 0 ? base : `${base}:${count}`;
  };

  // Track local import bindings -> resolved file path
  const importTargetByLocal = new Map<string, { targetFilePath?: string; exportedName: string; specifier: string }>();

  const fileDir = dirname(filePath);
  const resolveImportTarget = (specifier: string): string | undefined => {
    if (specifier.startsWith('.')) {
      const cacheKey = `rel:${fileDir}\0${specifier}`;
      if (importCache?.has(cacheKey)) return importCache.get(cacheKey);
      const rel = resolveRelativeModuleFile(filePath, specifier, knownFiles) ?? undefined;
      importCache?.set(cacheKey, rel);
      return rel;
    }
    const pkgCacheKey = `pkg:${specifier}`;
    let ws: string | undefined;
    if (importCache?.has(pkgCacheKey)) {
      ws = importCache.get(pkgCacheKey);
    } else {
      ws = resolveWorkspacePackageImport(specifier, allPackages, knownFiles) ?? undefined;
      importCache?.set(pkgCacheKey, ws);
    }
    if (ws) return ws;

    const aliasCacheKey = `alias:${pkg.packageKey}\0${specifier}`;
    let aliasTarget: string | undefined;
    if (importCache?.has(aliasCacheKey)) {
      aliasTarget = importCache.get(aliasCacheKey);
    } else {
      aliasTarget = resolvePackageAliasImport(specifier, pkg, knownFiles) ?? undefined;
      importCache?.set(aliasCacheKey, aliasTarget);
    }
    if (aliasTarget) return aliasTarget;
    if (plugin.resolveSpecialModule) {
      const specCacheKey = `spec:${plugin.id}:${pkg.rootPath}\0${specifier}`;
      if (importCache?.has(specCacheKey)) return importCache.get(specCacheKey);
      const special = plugin.resolveSpecialModule(specifier, filePath, pkg.rootPath) ?? undefined;
      importCache?.set(specCacheKey, special);
      if (special) return special;
    }
    return undefined;
  };

  let rootComponentUid: string | undefined;
  if (isSfc) {
    const compName = basename(filePath, ext);
    rootComponentUid = nextUid('component', compName);
    const totalLines = rawLineStarts.length;
    symbols.push({
      symbolUid: rootComponentUid,
      name: compName,
      kind: 'component',
      isExported: true,
      isDefault: true,
      signature: `<${compName} /> (${facts.framework})`,
      startOffset: 0,
      endOffset: rawContent.length,
      startLine: 1,
      endLine: totalLines,
      meta: { slots: facts.slots },
    });

    for (const slotName of facts.slots) {
      symbols.push({
        symbolUid: nextUid('slot', slotName),
        name: slotName,
        kind: 'slot',
        parentSymbolUid: rootComponentUid,
        isExported: true,
        isDefault: slotName === 'default',
        signature: `slot:${slotName}`,
        startOffset: 0,
        endOffset: 0,
        startLine: 1,
        endLine: 1,
      });
    }
  }

  // 1. Top-level declarations, imports, and re-exports
  for (const stmt of sf.statements) {
    // Skip synthetic template bridge function
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === '__strata_template__') {
      continue;
    }

    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const targetFilePath = resolveImportTarget(specifier);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());

      const clause = stmt.importClause;
      if (clause?.name) {
        importTargetByLocal.set(clause.name.text, { targetFilePath, exportedName: 'default', specifier });
      }
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          const isVirtualComponentsImport =
            specifier === '#components' || specifier === '#build/components';
          for (const el of clause.namedBindings.elements) {
            const exportedName = el.propertyName?.text ?? el.name.text;
            importTargetByLocal.set(el.name.text, {
              targetFilePath,
              exportedName,
              specifier,
            });
            if (isVirtualComponentsImport && !clause.isTypeOnly) {
              edges.push({
                sourceSymbolUid: rootComponentUid,
                targetName: exportedName,
                edgeKind: 'renders',
                isDynamic: false,
                confidence: 'heuristic',
                lineNumber: pos.startLine,
                startOffset: pos.startOffset,
                endOffset: pos.endOffset,
                payload: { viaVirtualImport: specifier },
              });
            }
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          importTargetByLocal.set(clause.namedBindings.name.text, {
            targetFilePath,
            exportedName: '*',
            specifier,
          });
        }
      }

      edges.push({
        sourceSymbolUid: rootComponentUid,
        targetFilePath,
        targetName: specifier,
        edgeKind: 'imports',
        isDynamic: false,
        confidence: 'syntax',
        lineNumber: pos.startLine,
        startOffset: pos.startOffset,
        endOffset: pos.endOffset,
        payload: { isTypeOnly: Boolean(clause?.isTypeOnly) },
      });
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const targetFilePath = resolveImportTarget(specifier);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      const exportedNames: string[] = [];
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exportedNames.push(el.name.text);
        }
      } else {
        exportedNames.push('*');
      }
      edges.push({
        targetFilePath,
        targetName: specifier,
        edgeKind: 'reexports',
        isDynamic: false,
        confidence: 'syntax',
        lineNumber: pos.startLine,
        startOffset: pos.startOffset,
        endOffset: pos.endOffset,
        payload: { names: exportedNames },
      });
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const { isExported, isDefault } = hasExportModifier(stmt);
      const kind = classifyCallableKind(name, isJsxFile);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      const uid = nextUid(kind, name);
      if (kind === 'component' && !rootComponentUid) rootComponentUid = uid;
      symbols.push({
        symbolUid: uid,
        name,
        kind,
        parentSymbolUid: isSfc ? rootComponentUid : undefined,
        isExported,
        isDefault,
        signature: compactSignature(stmt, sf),
        ...pos,
      });
      continue;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const { isExported, isDefault } = hasExportModifier(stmt);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      const classUid = nextUid('class', name);
      symbols.push({
        symbolUid: classUid,
        name,
        kind: 'class',
        isExported,
        isDefault,
        signature: compactSignature(stmt, sf),
        ...pos,
      });
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const mPos = mapToOriginal(doc, rawContent, rawLineStarts, member.getStart(sf), member.getEnd());
          symbols.push({
            symbolUid: nextUid('method', `${name}.${member.name.text}`),
            name: member.name.text,
            kind: 'method',
            parentSymbolUid: classUid,
            isExported,
            isDefault: false,
            signature: compactSignature(member, sf),
            ...mPos,
          });
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt)) {
      const { isExported, isDefault } = hasExportModifier(stmt);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      symbols.push({
        symbolUid: nextUid('interface', stmt.name.text),
        name: stmt.name.text,
        kind: 'interface',
        isExported,
        isDefault,
        signature: compactSignature(stmt, sf),
        ...pos,
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(stmt)) {
      const { isExported, isDefault } = hasExportModifier(stmt);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      symbols.push({
        symbolUid: nextUid('type', stmt.name.text),
        name: stmt.name.text,
        kind: 'type',
        isExported,
        isDefault,
        signature: compactSignature(stmt, sf),
        ...pos,
      });
      continue;
    }

    if (ts.isEnumDeclaration(stmt)) {
      const { isExported, isDefault } = hasExportModifier(stmt);
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      symbols.push({
        symbolUid: nextUid('enum', stmt.name.text),
        name: stmt.name.text,
        kind: 'enum',
        isExported,
        isDefault,
        signature: compactSignature(stmt, sf),
        ...pos,
      });
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      const { isExported, isDefault } = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const isFnInit = Boolean(init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)));
        const isContextInit = Boolean(
          init &&
            ts.isCallExpression(init) &&
            ((ts.isIdentifier(init.expression) && init.expression.text === 'createContext') ||
              (ts.isPropertyAccessExpression(init.expression) &&
                init.expression.name.text === 'createContext'))
        );
        const kind: ExtractedSymbolKind = isContextInit
          ? 'context'
          : isFnInit
            ? classifyCallableKind(name, isJsxFile)
            : 'variable';
        // Keep exported variables, functions/composables/stores/contexts, or SFC script-setup top-level bindings
        if (!isExported && kind === 'variable' && !isSfc) continue;
        const pos = mapToOriginal(doc, rawContent, rawLineStarts, decl.getStart(sf), decl.getEnd());
        const uid = nextUid(kind, name);
        if (kind === 'component' && !rootComponentUid) rootComponentUid = uid;
        symbols.push({
          symbolUid: uid,
          name,
          kind,
          parentSymbolUid: isSfc && uid !== rootComponentUid ? rootComponentUid : undefined,
          isExported,
          isDefault,
          signature: compactSignature(decl, sf),
          ...pos,
        });
      }
      continue;
    }

    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, stmt.getStart(sf), stmt.getEnd());
      if (ts.isObjectLiteralExpression(expr)) {
        const defUid = nextUid('variable', 'default');
        symbols.push({
          symbolUid: defUid,
          name: 'default',
          kind: 'variable',
          isExported: true,
          isDefault: true,
          signature: 'export default { ... }',
          ...pos,
        });
        for (const prop of expr.properties) {
          if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
            const mPos = mapToOriginal(doc, rawContent, rawLineStarts, prop.getStart(sf), prop.getEnd());
            symbols.push({
              symbolUid: nextUid('method', `default.${prop.name.text}`),
              name: prop.name.text,
              kind: 'method',
              parentSymbolUid: defUid,
              isExported: true,
              isDefault: false,
              signature: compactSignature(prop, sf),
              ...mPos,
            });
          } else if (
            ts.isPropertyAssignment(prop) &&
            prop.name &&
            ts.isIdentifier(prop.name) &&
            (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
          ) {
            const mPos = mapToOriginal(doc, rawContent, rawLineStarts, prop.getStart(sf), prop.getEnd());
            symbols.push({
              symbolUid: nextUid('method', `default.${prop.name.text}`),
              name: prop.name.text,
              kind: 'method',
              parentSymbolUid: defUid,
              isExported: true,
              isDefault: false,
              signature: compactSignature(prop, sf),
              ...mPos,
            });
          }
        }
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        const name = ts.isFunctionExpression(expr) && expr.name ? expr.name.text : 'default';
        symbols.push({
          symbolUid: nextUid(classifyCallableKind(name, isJsxFile), name),
          name,
          kind: classifyCallableKind(name, isJsxFile),
          isExported: true,
          isDefault: true,
          signature: compactSignature(stmt, sf),
          ...pos,
        });
      }
    }
  }

  // Extract named nested function declarations / function initializers inside directives/plugins (non-minified)
  if (rawContent.length <= 200_000) {
    const topLevelNames = new Set(symbols.map((s) => `${s.name}:${s.startOffset}`));
    const collectNestedCallables = (node: ts.Node, depth: number): void => {
      if (depth > 10) return;
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text !== '__strata_template__') {
        const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
        const key = `${node.name.text}:${pos.startOffset}`;
        if (!topLevelNames.has(key)) {
          topLevelNames.add(key);
          symbols.push({
            symbolUid: nextUid('function', node.name.text),
            name: node.name.text,
            kind: 'function',
            isExported: false,
            isDefault: false,
            signature: compactSignature(node, sf),
            ...pos,
          });
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          const key = `${node.name.text}:${pos.startOffset}`;
          if (!topLevelNames.has(key)) {
            topLevelNames.add(key);
            symbols.push({
              symbolUid: nextUid('function', node.name.text),
              name: node.name.text,
              kind: 'function',
              isExported: false,
              isDefault: false,
              signature: compactSignature(node, sf),
              ...pos,
            });
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === '__strata_template__') return;
      ts.forEachChild(node, (child) => collectNestedCallables(child, depth + 1));
    };
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === '__strata_template__') continue;
      ts.forEachChild(stmt, (child) => collectNestedCallables(child, 1));
    }
  }

  // 2. Template / JSX component render edges & prop/event edges
  for (const usage of facts.componentUsages) {
    if (usage.tagName.endsWith('.Provider')) {
      const ctxName = usage.tagName.slice(0, -'.Provider'.length);
      const ctxImp = importTargetByLocal.get(ctxName);
      const startPos = posFromStarts(rawContent, rawLineStarts, usage.originalStart);
      edges.push({
        sourceSymbolUid: rootComponentUid,
        targetFilePath: ctxImp?.targetFilePath,
        targetName: ctxName,
        edgeKind: 'provides_context',
        isDynamic: false,
        confidence: 'syntax',
        lineNumber: startPos.line,
        startOffset: usage.originalStart,
        endOffset: usage.originalEnd,
      });
    }
    const imp = importTargetByLocal.get(usage.normalizedName) ?? importTargetByLocal.get(usage.tagName);
    const startPos = posFromStarts(rawContent, rawLineStarts, usage.originalStart);
    edges.push({
      sourceSymbolUid: rootComponentUid,
      targetFilePath: imp?.targetFilePath,
      targetName: usage.normalizedName,
      edgeKind: 'renders',
      isDynamic: usage.hasDynamicSpread,
      confidence: imp?.targetFilePath ? 'syntax' : 'heuristic',
      lineNumber: startPos.line,
      startOffset: usage.originalStart,
      endOffset: usage.originalEnd,
      payload: {
        tagName: usage.tagName,
        props: usage.props.map((p) => p.name),
        events: usage.events.map((e) => e.name),
        hasDynamicSpread: usage.hasDynamicSpread,
      },
    });
  }

  // Track local callable symbols for intra-file and template event call-hierarchy tracking
  const localCallableNames = new Set<string>(
    symbols
      .filter((s) => s.kind === 'function' || s.kind === 'composable' || s.kind === 'store')
      .map((s) => s.name)
  );

  // 3. Lightweight call, state (Pinia + Nuxt useState), and outbound HTTP scan in AST
  const useStateVars = new Map<string, string>();
  const writeValueStartOffsets = new Set<number>();

  const collectUseStateDecls = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'useState'
    ) {
      const firstArg = node.initializer.arguments[0];
      const stateKey =
        firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))
          ? firstArg.text
          : node.name.text;
      useStateVars.set(node.name.text, stateKey);
    }
    ts.forEachChild(node, collectUseStateDecls);
  };
  collectUseStateDecls(sf);

  const findUseStateValueAccess = (expr: ts.Expression): { varName: string; stateKey: string; accessNode: ts.PropertyAccessExpression } | null => {
    let cur: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      if (
        ts.isPropertyAccessExpression(cur) &&
        cur.name.text === 'value' &&
        ts.isIdentifier(cur.expression) &&
        useStateVars.has(cur.expression.text)
      ) {
        return {
          varName: cur.expression.text,
          stateKey: useStateVars.get(cur.expression.text)!,
          accessNode: cur,
        };
      }
      cur = cur.expression;
    }
    return null;
  };

  const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);

  const visitExpr = (node: ts.Node): void => {
    if (
      useStateVars.size > 0 &&
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
    ) {
      const target = findUseStateValueAccess(node.left);
      if (target) {
        writeValueStartOffsets.add(target.accessNode.getStart(sf));
        const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
        edges.push({
          sourceSymbolUid: rootComponentUid,
          targetName: target.stateKey,
          edgeKind: 'writes_state',
          isDynamic: false,
          confidence: 'syntax',
          lineNumber: pos.startLine,
          startOffset: pos.startOffset,
          endOffset: pos.endOffset,
          payload: { stateVar: target.varName },
        });
      }
    } else if (
      useStateVars.size > 0 &&
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const target = findUseStateValueAccess(node.operand);
      if (target) {
        writeValueStartOffsets.add(target.accessNode.getStart(sf));
        const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
        edges.push({
          sourceSymbolUid: rootComponentUid,
          targetName: target.stateKey,
          edgeKind: 'writes_state',
          isDynamic: false,
          confidence: 'syntax',
          lineNumber: pos.startLine,
          startOffset: pos.startOffset,
          endOffset: pos.endOffset,
          payload: { stateVar: target.varName },
        });
      }
    } else if (
      useStateVars.size > 0 &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'value' &&
      ts.isIdentifier(node.expression) &&
      useStateVars.has(node.expression.text) &&
      !writeValueStartOffsets.has(node.getStart(sf))
    ) {
      const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
      edges.push({
        sourceSymbolUid: rootComponentUid,
        targetName: useStateVars.get(node.expression.text)!,
        edgeKind: 'reads_state',
        isDynamic: false,
        confidence: 'syntax',
        lineNumber: pos.startLine,
        startOffset: pos.startOffset,
        endOffset: pos.endOffset,
        payload: { stateVar: node.expression.text },
      });
    }

    // Track PascalCase component identifier references passed in object literals (e.g. `{ ProseImg: DocsProseImg }`)
    if (
      (ts.isPropertyAssignment(node) && ts.isIdentifier(node.initializer)) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const refIdent = ts.isPropertyAssignment(node)
        ? (node.initializer as ts.Identifier)
        : node.name;
      const refName = refIdent.text;
      if (/^[A-Z][A-Za-z0-9]+$/.test(refName)) {
        const imp = importTargetByLocal.get(refName);
        if (!imp || imp.specifier === '#components' || imp.specifier === '#build/components') {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, refIdent.getStart(sf), refIdent.getEnd());
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetFilePath: imp?.targetFilePath,
            targetName: imp?.exportedName ?? refName,
            edgeKind: 'renders',
            isDynamic: false,
            confidence: 'heuristic',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
            payload: { viaObjectRef: true },
          });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      const extractMethodFromOptionsArg = (
        optArg: ts.Expression | undefined
      ): { method: string; isDynamicMethod: boolean } => {
        if (!optArg) return { method: 'GET', isDynamicMethod: false };
        if (!ts.isObjectLiteralExpression(optArg)) {
          return { method: 'DYNAMIC', isDynamicMethod: true };
        }
        for (const prop of optArg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            prop.name &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
            prop.name.text === 'method'
          ) {
            if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
              return { method: prop.initializer.text.toUpperCase(), isDynamicMethod: false };
            }
            return { method: 'DYNAMIC', isDynamicMethod: true };
          }
          if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'method') {
            return { method: 'DYNAMIC', isDynamicMethod: true };
          }
        }
        return { method: 'GET', isDynamicMethod: false };
      };

      const extractUrlText = (arg: ts.Expression | undefined): { url: string; isDynamic: boolean } => {
        if (!arg) return { url: 'unknown', isDynamic: true };
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          return { url: arg.text, isDynamic: false };
        }
        return { url: arg.getText(sf).slice(0, 120), isDynamic: true };
      };

      if (ts.isIdentifier(expr)) {
        const callee = expr.text;
        if (/^use[A-Z][A-Za-z0-9_$]*Store$/.test(callee)) {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          const imp = importTargetByLocal.get(callee);
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetFilePath: imp?.targetFilePath,
            targetName: callee,
            edgeKind: 'reads_state',
            isDynamic: false,
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
          });
        } else if (callee === 'fetch' || callee === '$fetch' || callee === 'useFetch' || callee === 'useLazyFetch') {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          const { url, isDynamic } = extractUrlText(node.arguments[0]);
          const { method, isDynamicMethod } = extractMethodFromOptionsArg(node.arguments[1]);
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetName: url,
            edgeKind: 'outbound_http',
            isDynamic: isDynamic || isDynamicMethod,
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
            payload: { client: callee, url, method, isDynamicMethod },
          });
        } else if (callee === 'useSWR' || callee === 'useSWRMutation') {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          const { url, isDynamic } = extractUrlText(node.arguments[0]);
          const isMutation = callee === 'useSWRMutation';
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetName: url,
            edgeKind: 'outbound_http',
            isDynamic: isDynamic || isMutation,
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
            payload: { client: callee, url, method: isMutation ? 'DYNAMIC' : 'GET', isDynamicMethod: isMutation },
          });
        } else if (callee === 'useContext' || callee === 'inject') {
          const arg0 = node.arguments[0];
          const ctxName =
            arg0 && ts.isIdentifier(arg0)
              ? arg0.text
              : arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0))
                ? arg0.text
                : undefined;
          if (ctxName) {
            const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
            const imp = ts.isIdentifier(arg0!) ? importTargetByLocal.get(ctxName) : undefined;
            edges.push({
              sourceSymbolUid: rootComponentUid,
              targetFilePath: imp?.targetFilePath,
              targetName: ctxName,
              edgeKind: 'consumes_context',
              isDynamic: false,
              confidence: 'syntax',
              lineNumber: pos.startLine,
              startOffset: pos.startOffset,
              endOffset: pos.endOffset,
            });
          }
        } else if (callee === 'provide') {
          const arg0 = node.arguments[0];
          const ctxName =
            arg0 && ts.isIdentifier(arg0)
              ? arg0.text
              : arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0))
                ? arg0.text
                : undefined;
          if (ctxName) {
            const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
            const imp = ts.isIdentifier(arg0!) ? importTargetByLocal.get(ctxName) : undefined;
            edges.push({
              sourceSymbolUid: rootComponentUid,
              targetFilePath: imp?.targetFilePath,
              targetName: ctxName,
              edgeKind: 'provides_context',
              isDynamic: false,
              confidence: 'syntax',
              lineNumber: pos.startLine,
              startOffset: pos.startOffset,
              endOffset: pos.endOffset,
            });
          }
        } else if (importTargetByLocal.has(callee)) {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          const imp = importTargetByLocal.get(callee)!;
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetFilePath: imp.targetFilePath,
            targetName: callee,
            edgeKind: 'calls',
            isDynamic: false,
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
          });
        } else if (localCallableNames.has(callee)) {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetFilePath: filePath,
            targetName: callee,
            edgeKind: 'calls',
            isDynamic: false,
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
          });
        } else if (callee !== 'useState' && /^use[A-Z][A-Za-z0-9_$]*$/.test(callee)) {
          const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetName: callee,
            edgeKind: 'calls',
            isDynamic: false,
            confidence: 'heuristic',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
          });
        }
      } else if (ts.isPropertyAccessExpression(expr)) {
        const methodProp = expr.name.text;
        if (methodProp === 'useContext') {
          const arg0 = node.arguments[0];
          const ctxName = arg0 && ts.isIdentifier(arg0) ? arg0.text : undefined;
          if (ctxName) {
            const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
            const imp = importTargetByLocal.get(ctxName);
            edges.push({
              sourceSymbolUid: rootComponentUid,
              targetFilePath: imp?.targetFilePath,
              targetName: ctxName,
              edgeKind: 'consumes_context',
              isDynamic: false,
              confidence: 'syntax',
              lineNumber: pos.startLine,
              startOffset: pos.startOffset,
              endOffset: pos.endOffset,
            });
          }
        }
        const lowerMethodProp = methodProp.toLowerCase();
        const HTTP_CLIENT_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
        if (HTTP_CLIENT_METHODS.has(lowerMethodProp)) {
          const receiverText = expr.expression.getText(sf);
          const receiverLeaf = ts.isIdentifier(expr.expression)
            ? expr.expression.text
            : ts.isPropertyAccessExpression(expr.expression)
              ? expr.expression.name.text
              : '';
          const imp = receiverLeaf ? importTargetByLocal.get(receiverLeaf) : undefined;
          const isHttpClient =
            /^(?:\$?axios|\$?http|api|apiClient|httpClient|ky|got|request)$/i.test(receiverLeaf) ||
            Boolean(imp && /(?:^|\/)(?:api|axios|http|client)(?:\.[a-z]+)?$/i.test(imp.specifier));
          if (isHttpClient && node.arguments.length > 0) {
            const pos = mapToOriginal(doc, rawContent, rawLineStarts, node.getStart(sf), node.getEnd());
            let url: string;
            let isDynamic: boolean;
            let method = methodProp.toUpperCase();
            let isDynamicMethod = false;

            if (lowerMethodProp === 'request') {
              const arg0 = node.arguments[0];
              if (arg0 && ts.isObjectLiteralExpression(arg0)) {
                let urlPropExpr: ts.Expression | undefined;
                for (const p of arg0.properties) {
                  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'url') {
                    urlPropExpr = p.initializer;
                  }
                }
                const extracted = extractUrlText(urlPropExpr);
                url = extracted.url;
                isDynamic = extracted.isDynamic;
                const mRes = extractMethodFromOptionsArg(arg0);
                method = mRes.method;
                isDynamicMethod = mRes.isDynamicMethod;
              } else {
                const extracted = extractUrlText(arg0);
                url = extracted.url;
                isDynamic = true;
                method = 'DYNAMIC';
                isDynamicMethod = true;
              }
            } else {
              const extracted = extractUrlText(node.arguments[0]);
              url = extracted.url;
              isDynamic = extracted.isDynamic;
            }

            edges.push({
              sourceSymbolUid: rootComponentUid,
              targetName: url,
              edgeKind: 'outbound_http',
              isDynamic: isDynamic || isDynamicMethod,
              confidence: 'syntax',
              lineNumber: pos.startLine,
              startOffset: pos.startOffset,
              endOffset: pos.endOffset,
              payload: { client: receiverText, url, method, isDynamicMethod },
            });
          }
        }
      }
    }
    ts.forEachChild(node, visitExpr);
  };
  visitExpr(sf);

  // Also scan __strata_template__ for local callable references (e.g. @submit.prevent="onSubmit")
  if (localCallableNames.size > 0) {
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === '__strata_template__' && stmt.body) {
        const seenTemplateCalls = new Set<string>();
        const walkTpl = (n: ts.Node): void => {
          if (ts.isIdentifier(n) && localCallableNames.has(n.text)) {
            const pos = mapToOriginal(doc, rawContent, rawLineStarts, n.getStart(sf), n.getEnd());
            const key = `${n.text}:${pos.startLine}`;
            if (!seenTemplateCalls.has(key)) {
              seenTemplateCalls.add(key);
              edges.push({
                sourceSymbolUid: rootComponentUid,
                targetFilePath: filePath,
                targetName: n.text,
                edgeKind: 'listens_event',
                isDynamic: false,
                confidence: 'syntax',
                lineNumber: pos.startLine,
                startOffset: pos.startOffset,
                endOffset: pos.endOffset,
              });
            }
          }
          ts.forEachChild(n, walkTpl);
        };
        walkTpl(stmt.body);
      }
    }
  }
  const emitsSet = new Set<string>();
  const modelsList: Array<{ name: string; type?: string; required: boolean }> = [];
  if (facts.framework === 'vue' || facts.framework === 'nuxt') {
    const collectVueMacros = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const macro = node.expression.text;
        if (macro === 'defineEmits') {
          const arg0 = node.arguments[0];
          if (arg0 && ts.isArrayLiteralExpression(arg0)) {
            for (const el of arg0.elements) {
              if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
                emitsSet.add(el.text);
              }
            }
          } else if (arg0 && ts.isObjectLiteralExpression(arg0)) {
            for (const prop of arg0.properties) {
              if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
                emitsSet.add(prop.name.text);
              }
            }
          }
          const extractEmitsFromMembers = (members: ts.NodeArray<ts.TypeElement>) => {
            for (const member of members) {
              if (ts.isCallSignatureDeclaration(member)) {
                const firstParam = member.parameters[0];
                if (
                  firstParam?.type &&
                  ts.isLiteralTypeNode(firstParam.type) &&
                  ts.isStringLiteral(firstParam.type.literal)
                ) {
                  emitsSet.add(firstParam.type.literal.text);
                }
              } else if (
                ts.isPropertySignature(member) &&
                member.name &&
                (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
              ) {
                emitsSet.add(member.name.text);
              }
            }
          };

          const typeArg = node.typeArguments?.[0];
          if (typeArg && ts.isTypeLiteralNode(typeArg)) {
            extractEmitsFromMembers(typeArg.members);
          } else if (typeArg && ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
            const targetTypeName = typeArg.typeName.text;
            for (const stmt of sf.statements) {
              if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === targetTypeName) {
                extractEmitsFromMembers(stmt.members);
              } else if (
                ts.isTypeAliasDeclaration(stmt) &&
                stmt.name.text === targetTypeName &&
                ts.isTypeLiteralNode(stmt.type)
              ) {
                extractEmitsFromMembers(stmt.type.members);
              }
            }
          }
        } else if (macro === 'defineModel') {
          const arg0 = node.arguments[0];
          const arg1 = node.arguments[1];
          let modelName = 'modelValue';
          let optionsObj: ts.ObjectLiteralExpression | undefined;
          if (arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0))) {
            modelName = arg0.text;
            if (arg1 && ts.isObjectLiteralExpression(arg1)) optionsObj = arg1;
          } else if (arg0 && ts.isObjectLiteralExpression(arg0)) {
            optionsObj = arg0;
          }
          let required = false;
          if (optionsObj) {
            for (const prop of optionsObj.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === 'required' &&
                prop.initializer.kind === ts.SyntaxKind.TrueKeyword
              ) {
                required = true;
              }
            }
          }
          const typeText = node.typeArguments?.[0]?.getText(sf);
          modelsList.push({
            name: modelName,
            ...(typeText ? { type: typeText } : {}),
            required,
          });
        }
      }
      ts.forEachChild(node, collectVueMacros);
    };
    collectVueMacros(sf);
  }

  const { isPage, isLayout } = isPageOrLayoutPath(relPath);

  return {
    filePath,
    relPath,
    framework: facts.framework,
    contentHash,
    isPage,
    isLayout,
    renderBoundary: facts.renderBoundary ?? 'universal',
    boundaryDirective: facts.boundaryDirective,
    symbols,
    edges,
    omissionsCount: doc.omissions.length + facts.omissions.length,
    contractSummary: {
      slots: facts.slots,
      emits: [...emitsSet],
      models: modelsList,
      omissions: [...doc.omissions, ...facts.omissions],
    },
  };
}
