import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createDocumentAdapter } from '../../adapters/factory';
import type { BoundaryContract, ComponentContract, InputDependency } from '../../types';
import { checkAnalysisCancelled } from '../analysis-context';
import { canonicalizePath } from '../path-resolver';
import { reactBindings } from '../parsers/react-bindings';
import { readSourceFile } from '../source-file';
import { parseTypeScript } from '../source-parser';
import { resolveModuleFilePath } from '../symbol-resolver';
import { extractBoundaryContracts } from './boundaries';

type ImportedCall = { localName: string; importedName: string; source: string };

function collectImportedCalls(file: string, content: string): ImportedCall[] {
  const adapter = createDocumentAdapter(file, content);
  const calls = new Map<string, ImportedCall>();
  const vueScriptImports = new Map<string, ImportedCall>();
  for (const block of adapter.getScriptBlocks()) {
    const kind = adapter.isJsx() || /^(?:tsx|jsx)$/.test(block.lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const ast = parseTypeScript(file, block.content, kind);
    const bindings = reactBindings(ast);
    const importFor = (identifier: ts.Identifier): ImportedCall | undefined => {
      const binding = bindings.imported(identifier);
      if (!binding?.source || !binding.imported) return;
      const localName = identifier.text;
      if (localName.startsWith('use') || binding.imported.startsWith('use')) {
        return { localName, importedName: binding.imported, source: binding.source };
      }
    };

    if (adapter.type === 'vue' && block.type === 'script') {
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const clause = statement.importClause;
        const names = clause?.namedBindings;
        const identifiers = names && ts.isNamedImports(names) ? names.elements.map(element => element.name) : [];
        if (clause?.name) identifiers.push(clause.name);
        for (const identifier of identifiers) {
          const imported = importFor(identifier);
          if (imported) vueScriptImports.set(identifier.text, imported);
        }
      }
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression;
        const inherited = block.type === 'scriptSetup' && !bindings.binding(callee)
          ? vueScriptImports.get(callee.text)
          : undefined;
        const imported = importFor(callee) ?? inherited;
        if (imported) calls.set(JSON.stringify(imported), imported);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return [...calls.values()];
}

function* findHookDeclarations(ast: ts.SourceFile, importedName: string): Iterable<ts.Node> {
  const defaultExport = ast.statements.find(ts.isExportAssignment);
  const defaultBinding = defaultExport && !defaultExport.isExportEquals && ts.isIdentifier(defaultExport.expression)
    ? defaultExport.expression.text
    : undefined;
  const declarationName = importedName === 'default' ? defaultBinding : importedName;
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const isDefault = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault ? importedName === 'default' : declarationName && statement.name?.text === declarationName) {
        yield statement;
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === declarationName
          && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          yield declaration.initializer;
        }
      }
    }
    if (importedName === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals
      && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))) {
      yield statement.expression;
    }
  }
}

export async function extractImportedComposableBoundaries(file: string, content: string, workspaceRoot: string) {
  const boundaries: BoundaryContract[] = [];
  const dependencies: InputDependency[] = [];
  const diagnostics: NonNullable<ComponentContract['boundaryDiagnostics']> = [];
  for (const call of collectImportedCalls(file, content)) {
    checkAnalysisCancelled();
    const path = resolveModuleFilePath(file, call.source, workspaceRoot);
    if (!path || canonicalizePath(path) === canonicalizePath(file)) continue;
    let source: string;
    try {
      source = await readSourceFile(path);
    } catch (error) {
      checkAnalysisCancelled();
      if (error instanceof Error && error.message.startsWith('WORKSPACE_CHANGED:')) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push({ code: 'IMPORTED_COMPOSABLE_READ_FAILED', reason: `${path}: ${reason}` });
      continue;
    }
    const canonicalPath = canonicalizePath(path);
    dependencies.push({ path: canonicalPath, hash: createHash('sha256').update(source).digest('hex'), isExternal: false });
    const ast = parseTypeScript(path, source, ts.ScriptKind.TSX);
    for (const hook of findHookDeclarations(ast, call.importedName)) {
      const start = ast.getLineAndCharacterOfPosition(hook.getStart(ast));
      for (const boundary of extractBoundaryContracts(hook.getText(ast), 'ts', path)) {
        boundaries.push({
          ...boundary,
          ...(boundary.loc ? { loc: {
            line: boundary.loc.line + start.line,
            column: boundary.loc.column === undefined ? undefined
              : boundary.loc.column + (boundary.loc.line === 1 ? start.character : 0),
          } } : {}),
          source: 'imported-composable',
          viaComposable: call.localName,
        });
      }
    }
  }
  return { boundaries, dependencies, diagnostics };
}
