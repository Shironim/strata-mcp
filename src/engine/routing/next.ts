import { nextAppFileType } from './next-app-file';
import { parseTypeScript } from '../source-parser';
import { readSourceFile } from '../source-file';
import { basename, dirname, extname, normalize, relative } from 'node:path';
import ts from 'typescript';
import { unwrapExpression } from '../parsers/ts-syntax';
import { collectFiles } from '../collector';
import { deriveNextEffectiveConfig } from '../next-effective-config';
import type { NextSegmentConfigContract, RouteInfo } from '../../types';
import { extractRouteParams, extractApiHandlers } from './shared';

/**
 * Extracts Next.js App Router segment configuration via TypeScript AST.
 */
export function extractNextSegmentConfig(content: string): NextSegmentConfigContract | undefined {
  if (
    !content.includes('dynamic') &&
    !content.includes('revalidate') &&
    !content.includes('runtime') &&
    !content.includes('preferredRegion') &&
    !content.includes('dynamicParams') &&
    !content.includes('fetchCache') &&
    !content.includes('maxDuration') &&
    !content.includes('generateMetadata') &&
    !content.includes('generateStaticParams') &&
    !content.includes('export')
  ) {
    return undefined;
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = parseTypeScript('segment-config.ts', content, ts.ScriptKind.TSX);
  } catch {
    return undefined;
  }

  let dynamic: string | undefined;
  let dynamicParams: boolean | undefined;
  let revalidate: number | false | undefined;
  let fetchCache: string | undefined;
  let runtime: string | undefined;
  let preferredRegion: string | string[] | undefined;
  let maxDuration: number | undefined;
  let hasGenerateMetadata = false;
  let hasGenerateStaticParams = false;
  const unresolvedFields: NonNullable<NextSegmentConfigContract['unresolvedFields']> = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const configNames = new Set(['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration']);
      if (!statement.exportClause) unresolvedFields.push({ field: '*', expression: statement.getText(sourceFile), reason: 'Export-star segment config requires dependency resolution.' });
      else if (ts.isNamedExports(statement.exportClause)) for (const binding of statement.exportClause.elements) {
        if (!binding.isTypeOnly && configNames.has(binding.name.text)) unresolvedFields.push({ field: binding.name.text, expression: statement.getText(sourceFile), reason: 'Aliased or re-exported segment config is not established by a local exported literal declaration.' });
      }
    }
    if (ts.isFunctionDeclaration(statement)) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported && statement.name) {
        if (statement.name.text === 'generateMetadata') hasGenerateMetadata = true;
        if (statement.name.text === 'generateStaticParams') hasGenerateStaticParams = true;
      }
    }

    if (ts.isVariableStatement(statement)) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) continue;

      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) {
          const names: string[] = [];
          function binding(name: ts.BindingName): void {
            if (ts.isIdentifier(name)) names.push(name.text);
            else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
          }
          binding(decl.name);
          for (const name of names) if (['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'].includes(name)) {
            unresolvedFields.push({ field: name, expression: decl.getText(sourceFile), reason: 'Segment config needs a local named literal initializer; destructured or uninitialized exports are unresolved.' });
          }
          continue;
        }
        const name = decl.name.text;
        const init = unwrapExpression(decl.initializer);
        const configNames = ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'];
        if (configNames.includes(name)) {
          const literal = ['dynamic', 'fetchCache', 'runtime'].includes(name) ? ts.isStringLiteral(init)
            : name === 'dynamicParams' ? [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(init.kind)
            : name === 'preferredRegion' ? ts.isStringLiteral(init) || (ts.isArrayLiteralExpression(init) && init.elements.every(ts.isStringLiteral))
            : ts.isNumericLiteral(init) || (name === 'revalidate' && init.kind === ts.SyntaxKind.FalseKeyword);
          if (!literal) unresolvedFields.push({ field: name, expression: decl.initializer.getText(sourceFile), reason: 'Segment config requires a supported literal; computed values are not evaluated.' });
        }

        if (name === 'generateMetadata') hasGenerateMetadata = true;
        if (name === 'generateStaticParams') hasGenerateStaticParams = true;

        if (name === 'dynamic' && ts.isStringLiteral(init)) {
          dynamic = init.text;
        } else if (name === 'dynamicParams') {
          if (init.kind === ts.SyntaxKind.TrueKeyword) dynamicParams = true;
          if (init.kind === ts.SyntaxKind.FalseKeyword) dynamicParams = false;
        } else if (name === 'revalidate') {
          if (init.kind === ts.SyntaxKind.FalseKeyword) {
            revalidate = false;
          } else if (ts.isNumericLiteral(init)) {
            revalidate = Number(init.text);
          }
        } else if (name === 'fetchCache' && ts.isStringLiteral(init)) {
          fetchCache = init.text;
        } else if (name === 'runtime' && ts.isStringLiteral(init)) {
          runtime = init.text;
        } else if (name === 'preferredRegion') {
          if (ts.isStringLiteral(init)) {
            preferredRegion = init.text;
          } else if (ts.isArrayLiteralExpression(init) && init.elements.every(ts.isStringLiteral)) {
            preferredRegion = init.elements
              .filter(ts.isStringLiteral)
              .map((el) => el.text);
          }
        } else if (name === 'maxDuration' && ts.isNumericLiteral(init)) {
          maxDuration = Number(init.text);
        }
      }
    }
  }

  const hasAny =
    dynamic !== undefined ||
    dynamicParams !== undefined ||
    revalidate !== undefined ||
    fetchCache !== undefined ||
    runtime !== undefined ||
    preferredRegion !== undefined ||
    maxDuration !== undefined ||
    hasGenerateMetadata ||
    hasGenerateStaticParams || unresolvedFields.length > 0;

  if (!hasAny) return undefined;

  return {
    ...(dynamic !== undefined ? { dynamic } : {}),
    ...(dynamicParams !== undefined ? { dynamicParams } : {}),
    ...(revalidate !== undefined ? { revalidate } : {}),
    ...(fetchCache !== undefined ? { fetchCache } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    ...(preferredRegion !== undefined ? { preferredRegion } : {}),
    ...(maxDuration !== undefined ? { maxDuration } : {}),
    ...(hasGenerateMetadata ? { hasGenerateMetadata } : {}),
    ...(hasGenerateStaticParams ? { hasGenerateStaticParams } : {}),
    ...(unresolvedFields.length ? { unresolvedFields } : {}),
  };
}

export { nextAppFileType } from './next-app-file';

/** Scans a Next.js App Router directory and builds its route manifest. */
export async function scanNextAppRouter(baseDir: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  // Index all layout files
  const layoutFiles = files.filter(file => nextAppFileType(file) === 'layout');

  function getLayoutChain(fileDir: string): string[] {
    const chain: string[] = [];
    let cur = fileDir;
    while (cur.startsWith(baseDir)) {
      const match = layoutFiles.find((l) => dirname(l) === cur);
      if (match) {
        chain.unshift(normalize(match));
      }
      if (cur === baseDir) break;
      cur = dirname(cur);
    }
    return chain;
  }

  for (const file of files) {
    const routeType = nextAppFileType(file);
    if (!routeType) continue;

    const fileDir = dirname(file);
    const relDir = relative(baseDir, fileDir).replace(/\\/g, '/');

    // Parse route groups, parallel slots, and intercepting segments
    const rawSegments = relDir ? relDir.split('/').filter(Boolean) : [];
    const routeGroups: string[] = [];
    let parallelSlot: string | undefined;
    let intercepting: string | undefined;

    const urlSegments: string[] = [];
    for (const seg of rawSegments) {
      if (seg.startsWith('(') && seg.endsWith(')')) {
        routeGroups.push(seg);
      } else if (seg.startsWith('@')) {
        parallelSlot = seg;
      } else if (seg.startsWith('(.)') || seg.startsWith('(..)') || seg.startsWith('(...)')) {
        intercepting = seg;
        const actual = seg.replace(/^\(\.{1,3}\)/, '');
        if (actual) urlSegments.push(actual);
      } else {
        urlSegments.push(seg);
      }
    }

    const routePath = '/' + urlSegments.join('/');
    const normalizedPath = routePath === '//' ? '/' : routePath || '/';

    let segmentConfig: NextSegmentConfigContract | undefined;
    let handlers: string[] | undefined;

    try {
      const content = await readSourceFile(file);
      segmentConfig = extractNextSegmentConfig(content);
      if (routeType === 'api') {
        handlers = await extractApiHandlers(file);
      }
    } catch {
      // Ignore read errors
    }

    const layouts = getLayoutChain(fileDir);
    const effective = ['page', 'layout', 'api'].includes(routeType)
      ? await deriveNextEffectiveConfig(routeType === 'api' ? [file] : [...layouts, file], extractNextSegmentConfig)
      : undefined;
    routes.push({
      path: normalizedPath,
      filePath: normalize(file),
      type: routeType,
      framework: 'next-app',
      params: extractRouteParams(normalizedPath),
      layouts,
      ...(handlers ? { handlers } : {}),
      ...(routeGroups.length > 0 ? { routeGroups } : {}),
      ...(parallelSlot ? { parallelSlot } : {}),
      ...(intercepting ? { intercepting } : {}),
      ...(segmentConfig ? { nextSegmentConfig: segmentConfig } : {}),
      ...(effective ? { nextEffectiveSegmentConfig: effective } : {}),
    });
  }

  return routes;
}
