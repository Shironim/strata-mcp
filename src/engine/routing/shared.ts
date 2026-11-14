import { parseTypeScript } from '../source-parser';
import { readSourceFile } from '../source-file';
import ts from 'typescript';
import type { RouteParam } from '../../types';

/**
 * Extracts route parameters from a normalized route path string (e.g. [id], [...slug], [[...slug]]).
 */
export function extractRouteParams(routePath: string): RouteParam[] {
  const params: RouteParam[] = [];
  const segments = routePath.split('/');

  for (const seg of segments) {
    const optCatchAll = seg.match(/^\[\[\.\.\.([A-Za-z0-9_$]+)\]\]$/);
    if (optCatchAll) {
      params.push({ name: optCatchAll[1], type: 'optional-catch-all' });
      continue;
    }

    const catchAll = seg.match(/^\[\.\.\.([A-Za-z0-9_$]+)\]$/);
    if (catchAll) {
      params.push({ name: catchAll[1], type: 'catch-all' });
      continue;
    }

    const dynamic = seg.match(/^\[([A-Za-z0-9_$]+)\]$/);
    if (dynamic) {
      params.push({ name: dynamic[1], type: 'dynamic' });
      continue;
    }

    // 4. Vue router colon parameters (:param, :pathMatch(.*)*, etc.)
    const colonParam = seg.match(/^:([A-Za-z0-9_$]+)(\(.*?\))?(\*|\+)?$/);
    if (colonParam) {
      const isCatchAll = colonParam[3] === '*' || colonParam[3] === '+';
      params.push({ name: colonParam[1], type: isCatchAll ? 'catch-all' : 'dynamic' });
      continue;
    }
  }

  return params;
}

/**
 * Extracts exported HTTP methods (GET, POST, etc.) from an API route file.
 */
export async function extractApiHandlers(filePath: string): Promise<string[]> {
  try {
    const content = await readSourceFile(filePath);
    const methods = new Set<string>();
    const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    const sf = parseTypeScript(filePath, content, ts.ScriptKind.TS);
    for (const statement of sf.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const entry of statement.exportClause.elements) if (!entry.isTypeOnly) methods.add(entry.name.text);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement))
        && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        if (ts.isFunctionDeclaration(statement) && statement.name) methods.add(statement.name.text);
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) methods.add(declaration.name.text);
        }
      }
    }
    const handlers = httpMethods.filter(method => methods.has(method));
    return handlers.length > 0 ? handlers : ['ALL'];
  } catch {
    return [];
  }
}
