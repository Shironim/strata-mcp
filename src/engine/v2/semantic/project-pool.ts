import { extname } from 'node:path';
import ts from 'typescript';
import { assertSafeOffset, positionFromLineStarts } from '../../../utils/source-position';
import { canonicalizePath } from '../../path-resolver';
import {
  discoverWorkspacePackages,
  matchOwningPackage,
  type WorkspacePackageInfo,
} from '../workspace-packages';
import { createStrataLanguageServiceHost } from './language-host';
import { VirtualFileRegistry } from './virtual-registry';

export interface SemanticPoolConfig {
  maxActiveProjects: number;
  maxMemoryMb: number;
  idleTtlMs: number;
}

export interface SemanticLocation {
  filePath: string;
  startOffset: number;
  endOffset: number;
  line: number;
  column: number;
  kind?: string;
}

export interface SemanticReference extends SemanticLocation {
  isDefinition: boolean;
  isWriteAccess: boolean;
}

export interface SemanticPropInfo {
  name: string;
  type: string;
  required: boolean;
}

interface ActiveProject {
  key: string;
  pkg: WorkspacePackageInfo;
  languageService: ts.LanguageService;
  ambientMacrosPath: string;
  lastUsedAt: number;
}

const DEFAULT_POOL_CONFIG: SemanticPoolConfig = {
  maxActiveProjects: 3,
  maxMemoryMb: 512,
  idleTtlMs: 10 * 60 * 1000,
};

/**
 * Scoped TypeScript Semantic Engine Pool:
 * Lazily creates and caches ts.LanguageService instances per package/tsconfig
 * with LRU eviction, Virtual TSX projection, and bidirectional source remapping.
 */
export class SemanticProjectPool {
  private readonly config: SemanticPoolConfig;
  private readonly active = new Map<string, ActiveProject>();
  private readonly virtualRegistry = new VirtualFileRegistry();
  private readonly packageCache = new Map<string, WorkspacePackageInfo[]>();

  constructor(config: Partial<SemanticPoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  getActiveProjectCount(): number {
    return this.active.size;
  }

  getActiveProjectKeys(): string[] {
    return [...this.active.keys()];
  }

  private getPackages(workspaceRoot: string): WorkspacePackageInfo[] {
    const abs = canonicalizePath(workspaceRoot);
    let pkgs = this.packageCache.get(abs);
    if (!pkgs) {
      pkgs = discoverWorkspacePackages(abs);
      this.packageCache.set(abs, pkgs);
    }
    return pkgs;
  }

  private evictIfNeeded(now = Date.now()): void {
    // 1. Idle TTL eviction
    for (const [key, proj] of this.active.entries()) {
      if (now - proj.lastUsedAt >= this.config.idleTtlMs) {
        proj.languageService.dispose();
        this.active.delete(key);
      }
    }

    // 2. LRU eviction when exceeding maxActiveProjects or memory soft-cap
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const overMem = rssMb > this.config.maxMemoryMb;
    while (
      this.active.size > this.config.maxActiveProjects ||
      (overMem && this.active.size > 1)
    ) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, proj] of this.active.entries()) {
        if (proj.lastUsedAt < oldestTime) {
          oldestTime = proj.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.active.get(oldestKey)?.languageService.dispose();
      this.active.delete(oldestKey);
      if (this.active.size <= 1) break;
    }
  }

  acquireProject(workspaceRoot: string, packageKeyOrFilePath: string): ActiveProject | null {
    const absRoot = canonicalizePath(workspaceRoot);
    const allPackages = this.getPackages(absRoot);
    const pkg =
      allPackages.find((p) => p.packageKey === packageKeyOrFilePath) ??
      matchOwningPackage(packageKeyOrFilePath, allPackages);
    if (!pkg) return null;

    const projectKey = `${absRoot}\0${pkg.tsconfigPath ?? pkg.rootPath}`;
    const existing = this.active.get(projectKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // Make room before creating a new LanguageService
    if (this.active.size >= this.config.maxActiveProjects) {
      this.evictIfNeeded();
      while (this.active.size >= this.config.maxActiveProjects) {
        const firstKey = this.active.keys().next().value;
        if (!firstKey) break;
        this.active.get(firstKey)?.languageService.dispose();
        this.active.delete(firstKey);
      }
    }

    const { host, ambientMacrosPath } = createStrataLanguageServiceHost({
      pkg,
      allPackages,
      virtualRegistry: this.virtualRegistry,
    });
    const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

    const created: ActiveProject = {
      key: projectKey,
      pkg,
      languageService,
      ambientMacrosPath,
      lastUsedAt: Date.now(),
    };
    this.active.set(projectKey, created);
    return created;
  }

  private mapVirtualLocation(
    fileName: string,
    textSpan: ts.TextSpan,
    ambientMacrosPath: string
  ): SemanticLocation | null {
    if (fileName === ambientMacrosPath) return null;
    const entry = this.virtualRegistry.getForVirtual(fileName);
    if (!entry) return null;

    const mapped = entry.doc.toOriginalSpan(textSpan.start, textSpan.start + textSpan.length);
    if (!mapped) return null;

    assertSafeOffset(entry.rawContent, mapped.start);
    const pos = positionFromLineStarts(entry.getLineStarts(), mapped.start);
    return {
      filePath: entry.doc.originalPath,
      startOffset: mapped.start,
      endOffset: mapped.end,
      line: pos.line,
      column: pos.column,
      kind: mapped.kind,
    };
  }

  /**
   * Go to Definition at an original character offset inside any supported frontend file.
   */
  getDefinitionsAtOffset(
    workspaceRoot: string,
    filePath: string,
    originalOffset: number
  ): SemanticLocation[] {
    const absFile = canonicalizePath(filePath);
    const project = this.acquireProject(workspaceRoot, absFile);
    if (!project) return [];

    const entry = this.virtualRegistry.getForOriginal(absFile);
    if (!entry) return [];

    const virtOffset = entry.doc.toVirtualOffset(originalOffset);
    if (virtOffset === null) return [];

    const defs =
      project.languageService.getDefinitionAtPosition(entry.doc.virtualPath, virtOffset) ?? [];

    const results: SemanticLocation[] = [];
    const seen = new Set<string>();
    for (const d of defs) {
      const loc = this.mapVirtualLocation(d.fileName, d.textSpan, project.ambientMacrosPath);
      if (!loc) continue;
      const key = `${loc.filePath}:${loc.startOffset}:${loc.endOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(loc);
    }
    return results;
  }

  /**
   * Find All References at an original character offset, scoped to one package or a list of candidate packages.
   */
  findReferencesAtOffset(
    workspaceRoot: string,
    filePath: string,
    originalOffset: number,
    candidatePackageKeys?: string[]
  ): SemanticReference[] {
    const absFile = canonicalizePath(filePath);
    const allPackages = this.getPackages(workspaceRoot);
    const ownerPkg = matchOwningPackage(absFile, allPackages);
    const keysToSearch = candidatePackageKeys?.length
      ? candidatePackageKeys
      : ownerPkg
        ? [ownerPkg.packageKey]
        : [];

    const entry = this.virtualRegistry.getForOriginal(absFile);
    if (!entry) return [];

    const virtOffset = entry.doc.toVirtualOffset(originalOffset);
    if (virtOffset === null) return [];

    const results: SemanticReference[] = [];
    const seen = new Set<string>();

    for (const pkgKey of keysToSearch) {
      const project = this.acquireProject(workspaceRoot, pkgKey);
      if (!project) continue;

      const refSymbols =
        project.languageService.findReferences(entry.doc.virtualPath, virtOffset) ?? [];
      for (const refSym of refSymbols) {
        for (const ref of refSym.references) {
          const loc = this.mapVirtualLocation(ref.fileName, ref.textSpan, project.ambientMacrosPath);
          if (!loc) continue;
          const key = `${loc.filePath}:${loc.startOffset}:${loc.endOffset}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            ...loc,
            isDefinition: Boolean(ref.isDefinition),
            isWriteAccess: Boolean(ref.isWriteAccess),
          });
        }
      }
    }

    return results;
  }

  /**
   * Expands component props using TypeScript's TypeChecker:
   * - Vue: `defineProps<T>()` / `withDefaults(defineProps<T>(), ...)`
   * - React: exported PascalCase function component's first parameter type
   * - Svelte: `$props<T>()` or destructured `$props()` type annotation
   */
  expandComponentProps(workspaceRoot: string, filePath: string): SemanticPropInfo[] {
    const absFile = canonicalizePath(filePath);
    const project = this.acquireProject(workspaceRoot, absFile);
    if (!project) return [];

    const entry = this.virtualRegistry.getForOriginal(absFile);
    if (!entry) return [];

    const program = project.languageService.getProgram();
    if (!program) return [];
    const sf = program.getSourceFile(entry.doc.virtualPath);
    if (!sf) return [];

    const checker = program.getTypeChecker();
    const ext = extname(absFile).toLowerCase();

    const formatReadableType = (type: ts.Type): string => {
      if (type.isUnion() && type.types.length <= 12) {
        const allLiteralOrPrimitive = type.types.every(
          (t) =>
            (t.flags &
              (ts.TypeFlags.StringLiteral |
                ts.TypeFlags.NumberLiteral |
                ts.TypeFlags.BooleanLiteral |
                ts.TypeFlags.Undefined |
                ts.TypeFlags.Null)) !==
            0
        );
        if (allLiteralOrPrimitive) {
          return type.types
            .map((t) => checker.typeToString(t, sf, ts.TypeFormatFlags.NoTruncation))
            .join(' | ');
        }
      }
      return checker
        .typeToString(type, sf, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope)
        .replace(/import\([^)]+\)\./g, '');
    };

    const extractPropsFromType = (type: ts.Type): SemanticPropInfo[] => {
      const props: SemanticPropInfo[] = [];
      for (const sym of checker.getPropertiesOfType(type)) {
        const propType = checker.getTypeOfSymbolAtLocation(sym, sf);
        const isOptional = (sym.flags & ts.SymbolFlags.Optional) !== 0;
        props.push({
          name: sym.getName(),
          type: formatReadableType(propType),
          required: !isOptional,
        });
      }
      return props;
    };

    let propsType: ts.Type | undefined;

    if (ext === '.vue') {
      const visit = (node: ts.Node) => {
        if (propsType) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === 'defineProps') {
            if (node.typeArguments && node.typeArguments.length > 0) {
              propsType = checker.getTypeFromTypeNode(node.typeArguments[0]);
              return;
            }
            propsType = checker.getTypeAtLocation(node);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    } else if (ext === '.tsx' || ext === '.jsx') {
      const resolveReactWrapperPropsType = (expr: ts.Expression): ts.Type | undefined => {
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
          if (expr.parameters.length > 0) {
            const firstParam = expr.parameters[0]!;
            return firstParam.type
              ? checker.getTypeFromTypeNode(firstParam.type)
              : checker.getTypeAtLocation(firstParam);
          }
          return undefined;
        }
        if (ts.isCallExpression(expr)) {
          const calleeName = ts.isIdentifier(expr.expression)
            ? expr.expression.text
            : ts.isPropertyAccessExpression(expr.expression)
              ? expr.expression.name.text
              : '';
          if (calleeName === 'forwardRef') {
            if (expr.typeArguments && expr.typeArguments.length >= 2) {
              return checker.getTypeFromTypeNode(expr.typeArguments[1]!);
            }
            if (expr.arguments.length > 0) {
              return resolveReactWrapperPropsType(expr.arguments[0]!);
            }
          } else if (calleeName === 'memo') {
            if (expr.typeArguments && expr.typeArguments.length >= 1) {
              return checker.getTypeFromTypeNode(expr.typeArguments[0]!);
            }
            if (expr.arguments.length > 0) {
              return resolveReactWrapperPropsType(expr.arguments[0]!);
            }
          }
        }
        return undefined;
      };

      for (const stmt of sf.statements) {
        if (propsType) break;
        if (
          ts.isFunctionDeclaration(stmt) &&
          stmt.name &&
          /^[A-Z]/.test(stmt.name.text) &&
          stmt.parameters.length > 0
        ) {
          const firstParam = stmt.parameters[0]!;
          propsType = firstParam.type
            ? checker.getTypeFromTypeNode(firstParam.type)
            : checker.getTypeAtLocation(firstParam);
        } else if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              /^[A-Z]/.test(decl.name.text) &&
              decl.initializer
            ) {
              propsType = resolveReactWrapperPropsType(decl.initializer);
              if (propsType) break;
            }
          }
        } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
          propsType = resolveReactWrapperPropsType(stmt.expression);
        }
      }
    } else if (ext === '.svelte') {
      const visit = (node: ts.Node) => {
        if (propsType) return;
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === '$props'
        ) {
          if (node.type) {
            propsType = checker.getTypeFromTypeNode(node.type);
            return;
          }
          if (node.initializer.typeArguments?.length) {
            propsType = checker.getTypeFromTypeNode(node.initializer.typeArguments[0]);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    if (!propsType) return [];
    return extractPropsFromType(propsType);
  }

  /**
   * Expands Vue `defineEmits<T>()` event names using TypeScript's TypeChecker,
   * supporting imported interfaces and type aliases.
   */
  expandComponentEmits(workspaceRoot: string, filePath: string): string[] {
    const absFile = canonicalizePath(filePath);
    if (extname(absFile).toLowerCase() !== '.vue') return [];

    const project = this.acquireProject(workspaceRoot, absFile);
    if (!project) return [];
    const entry = this.virtualRegistry.getForOriginal(absFile);
    if (!entry) return [];
    const program = project.languageService.getProgram();
    if (!program) return [];
    const sf = program.getSourceFile(entry.doc.virtualPath);
    if (!sf) return [];

    const checker = program.getTypeChecker();
    const emits = new Set<string>();

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineEmits' &&
        node.typeArguments?.length
      ) {
        const emitsType = checker.getTypeFromTypeNode(node.typeArguments[0]!);
        for (const prop of checker.getPropertiesOfType(emitsType)) {
          emits.add(prop.getName());
        }
        for (const sig of emitsType.getCallSignatures()) {
          const firstParam = sig.getParameters()[0];
          if (firstParam) {
            const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sf);
            if (paramType.isStringLiteral()) {
              emits.add(paramType.value);
            } else if (paramType.isUnion()) {
              for (const t of paramType.types) {
                if (t.isStringLiteral()) emits.add(t.value);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...emits];
  }

  /**
   * Returns the TypeScript type string at an original character offset.
   */
  getTypeAtOffset(workspaceRoot: string, filePath: string, originalOffset: number): string | null {
    const absFile = canonicalizePath(filePath);
    const project = this.acquireProject(workspaceRoot, absFile);
    if (!project) return null;

    const entry = this.virtualRegistry.getForOriginal(absFile);
    if (!entry) return null;

    const virtOffset = entry.doc.toVirtualOffset(originalOffset);
    if (virtOffset === null) return null;

    const quickInfo = project.languageService.getQuickInfoAtPosition(entry.doc.virtualPath, virtOffset);
    if (!quickInfo?.displayParts?.length) return null;
    return ts.displayPartsToString(quickInfo.displayParts);
  }

  invalidateFile(filePath: string): void {
    this.virtualRegistry.invalidate(filePath);
  }

  disposeAll(): void {
    for (const proj of this.active.values()) {
      proj.languageService.dispose();
    }
    this.active.clear();
    this.virtualRegistry.clear();
    this.packageCache.clear();
  }
}

export const defaultSemanticPool = new SemanticProjectPool();
