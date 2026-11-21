import { basename, extname, relative } from 'node:path';
import ts from 'typescript';
import { defaultPluginRegistry, hashSourceContent, type VirtualDocument } from '../../plugins';
import { getSourcePosition } from '../../utils/source-position';
import {
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

function classifyCallableKind(name: string, isJsxFile: boolean): ExtractedSymbolKind {
  if (/^use[A-Z][A-Za-z0-9_$]*Store$/.test(name)) return 'store';
  if (/^use[A-Z][A-Za-z0-9_$]*$/.test(name)) return 'composable';
  if (isJsxFile && /^[A-Z][A-Za-z0-9_$]*$/.test(name)) return 'component';
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

function mapToOriginal(
  doc: VirtualDocument,
  rawContent: string,
  virtStart: number,
  virtEnd: number
): { startOffset: number; endOffset: number; startLine: number; endLine: number } {
  const mapped = doc.toOriginalSpan(virtStart, virtEnd);
  const startOffset = mapped ? mapped.start : 0;
  const endOffset = mapped ? mapped.end : startOffset;
  const startPos = getSourcePosition(rawContent, startOffset);
  const endPos = getSourcePosition(rawContent, endOffset);
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
  precomputedHash?: string
): Tier1ExtractionResult | null {
  const plugin = defaultPluginRegistry.resolveForFile(filePath);
  if (!plugin) return null;

  const contentHash = precomputedHash ?? hashSourceContent(rawContent);
  const doc = plugin.projectToVirtualTs(filePath, rawContent, contentHash);
  const facts = plugin.extractTier1Facts(doc, rawContent);
  const relPath = relative(pkg.rootPath, filePath).replace(/\\/g, '/');
  const fullKeyPrefix = `${pkg.packageKey}/${relPath}`;
  const ext = extname(filePath).toLowerCase();
  const isSfc = ext === '.vue' || ext === '.svelte' || ext === '.astro';
  const isJsxFile = ext === '.tsx' || ext === '.jsx';

  const sf = ts.createSourceFile(
    doc.virtualPath,
    doc.virtualCode,
    ts.ScriptTarget.Latest,
    true,
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

  const resolveImportTarget = (specifier: string): string | undefined => {
    const rel = resolveRelativeModuleFile(filePath, specifier);
    if (rel) return rel;
    const ws = resolveWorkspacePackageImport(specifier, allPackages);
    if (ws) return ws;
    if (plugin.resolveSpecialModule) {
      const special = plugin.resolveSpecialModule(specifier, filePath, pkg.rootPath);
      if (special) return special;
    }
    return undefined;
  };

  let rootComponentUid: string | undefined;
  if (isSfc) {
    const compName = basename(filePath, ext);
    rootComponentUid = nextUid('component', compName);
    const totalLines = rawContent.split('\n').length;
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());

      const clause = stmt.importClause;
      if (clause?.name) {
        importTargetByLocal.set(clause.name.text, { targetFilePath, exportedName: 'default', specifier });
      }
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            importTargetByLocal.set(el.name.text, {
              targetFilePath,
              exportedName: el.propertyName?.text ?? el.name.text,
              specifier,
            });
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
          const mPos = mapToOriginal(doc, rawContent, member.getStart(sf), member.getEnd());
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
      const pos = mapToOriginal(doc, rawContent, stmt.getStart(sf), stmt.getEnd());
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
        const kind: ExtractedSymbolKind = isFnInit
          ? classifyCallableKind(name, isJsxFile)
          : 'variable';
        // Keep exported variables, functions/composables/stores, or SFC script-setup top-level bindings
        if (!isExported && kind === 'variable' && !isSfc) continue;
        const pos = mapToOriginal(doc, rawContent, decl.getStart(sf), decl.getEnd());
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
    }
  }

  // 2. Template / JSX component render edges & prop/event edges
  for (const usage of facts.componentUsages) {
    const imp = importTargetByLocal.get(usage.normalizedName) ?? importTargetByLocal.get(usage.tagName);
    const startPos = getSourcePosition(rawContent, usage.originalStart);
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

  // 3. Lightweight call, state, and outbound HTTP scan in AST
  const visitExpr = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const pos = mapToOriginal(doc, rawContent, node.getStart(sf), node.getEnd());

      if (ts.isIdentifier(expr)) {
        const callee = expr.text;
        if (/^use[A-Z][A-Za-z0-9_$]*Store$/.test(callee)) {
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
        } else if (callee === 'fetch' || callee === '$fetch' || callee === 'useFetch') {
          const firstArg = node.arguments[0];
          const url = firstArg ? firstArg.getText(sf).slice(0, 120) : 'unknown';
          edges.push({
            sourceSymbolUid: rootComponentUid,
            targetName: url,
            edgeKind: 'outbound_http',
            isDynamic: Boolean(firstArg && !ts.isStringLiteral(firstArg)),
            confidence: 'syntax',
            lineNumber: pos.startLine,
            startOffset: pos.startOffset,
            endOffset: pos.endOffset,
            payload: { client: callee, url },
          });
        } else if (importTargetByLocal.has(callee)) {
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
        }
      }
    }
    ts.forEachChild(node, visitExpr);
  };
  visitExpr(sf);

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
      omissions: [...doc.omissions, ...facts.omissions],
    },
  };
}
