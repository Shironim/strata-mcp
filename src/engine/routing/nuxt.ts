import { parseTypeScript } from '../source-parser';
import { readSourceFile } from '../source-file';
import { existsSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import ts from 'typescript';
import { unwrapExpression, staticPropertyName } from '../parsers/ts-syntax';
import { parseSfc } from '../splitter';
import { collectFiles } from '../collector';
import type { NuxtPageMetaContract, RouteInfo } from '../../types';
import { extractRouteParams } from './shared';

/**
 * Extracts definePageMeta configuration from a Nuxt page file via TypeScript AST.
 */
export function extractNuxtPageMeta(content: string): NuxtPageMetaContract | undefined {
  if (!content.includes('definePageMeta')) return undefined;
  const script = content.includes('<script') ? parseSfc(content).scriptSetup?.content : content;
  if (!script) return undefined;
  const sf = parseTypeScript('page.ts', script, ts.ScriptKind.TS);
  const calls = sf.statements.filter(ts.isExpressionStatement).map(stmt => unwrapExpression(stmt.expression))
    .filter((expr): expr is ts.CallExpression => ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'definePageMeta');
  if (!calls.length) return undefined;
  const result: NuxtPageMetaContract = { customMetaKeys: [] };
  const unresolved: NonNullable<NuxtPageMetaContract['unresolvedFields']> = [];
  const unknown = (field: string, node: ts.Node, reason: string) => unresolved.push({ field, expression: node.getText(sf), reason });
  if (calls.length !== 1) {
    unknown('*', sf, 'Multiple definePageMeta calls cannot establish a single metadata object.');
  } else {
    const argument = calls[0].arguments[0];
    const object = argument && unwrapExpression(argument);
    if (!object || !ts.isObjectLiteralExpression(object)) unknown('*', calls[0], 'Metadata argument is not a local object literal.');
    else for (const prop of object.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // A later spread can override any field already observed.
        for (const field of ['layout', 'middleware', 'alias', 'keepalive', 'pageTransition'] as const) delete result[field];
        unknown('*', prop, 'Spread metadata keys and overrides are unresolved.');
        continue;
      }
      const name = prop.name && staticPropertyName(prop.name);
      if (name === undefined) {
        for (const field of ['layout', 'middleware', 'alias', 'keepalive', 'pageTransition'] as const) delete result[field];
        unknown('*', prop, 'Computed metadata key may override any known field.');
        continue;
      }
      if (!result.customMetaKeys.includes(name)) result.customMetaKeys.push(name);
      if (!['layout', 'middleware', 'alias', 'keepalive', 'pageTransition'].includes(name)) continue;
      delete result[name as 'layout'];
      if (!ts.isPropertyAssignment(prop)) { unknown(name, prop, 'Shorthand or method metadata requires value resolution.'); continue; }
      const init = unwrapExpression(prop.initializer);
      if (name === 'layout' && (ts.isStringLiteral(init) || init.kind === ts.SyntaxKind.FalseKeyword)) {
        result.layout = ts.isStringLiteral(init) ? init.text : false;
      } else if (name === 'middleware' || name === 'alias') {
        if (ts.isStringLiteral(init)) result[name] = [init.text];
        else if (ts.isArrayLiteralExpression(init) && init.elements.every(el => ts.isStringLiteral(unwrapExpression(el as ts.Expression)))) {
          result[name] = init.elements.map(el => (unwrapExpression(el as ts.Expression) as ts.StringLiteral).text);
        } else unknown(name, init, 'Metadata list contains dynamic values or inline guards; a complete string list is unavailable.');
      } else if ((name === 'keepalive' || name === 'pageTransition') && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(init.kind)) {
        result[name] = init.kind === ts.SyntaxKind.TrueKeyword;
      } else unknown(name, init, 'Metadata value is dynamic or outside the supported literal shape.');
    }
  }
  if (unresolved.length) result.unresolvedFields = unresolved;
  return result;
}

/**
 * Scans a Nuxt 3/4 pages directory and builds its route manifest.
 */
export async function scanNuxtPages(baseDir: string, projectRoot: string): Promise<RouteInfo[]> {
  if (!existsSync(baseDir)) return [];
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  // Check default layout
  const defaultLayoutCandidates = [
    join(projectRoot, 'app', 'layouts', 'default.vue'),
    join(projectRoot, 'src', 'app', 'layouts', 'default.vue'),
    join(projectRoot, 'layouts', 'default.vue'),
    join(projectRoot, 'src', 'layouts', 'default.vue'),
  ];
  const defaultLayout = defaultLayoutCandidates.find((c) => existsSync(c));
  const hasDefaultLayout = Boolean(defaultLayout);

  for (const file of files) {
    if (!file.endsWith('.vue')) continue;

    const rel = relative(baseDir, file).replace(/\\/g, '/');
    let routePath = '/' + rel.replace(/\.vue$/, '');

    // Convert index to /
    if (routePath.endsWith('/index')) {
      routePath = routePath.slice(0, -6) || '/';
    }

    let pageLayouts: string[] | undefined;
    let explicitlyDisabledLayout = false;
    let pageMeta: NuxtPageMetaContract | undefined;

    try {
      const content = await readSourceFile(file);
      pageMeta = extractNuxtPageMeta(content);

      if (pageMeta?.layout === false) {
        explicitlyDisabledLayout = true;
      } else {
        const layoutName = typeof pageMeta?.layout === 'string' ? pageMeta.layout : undefined;
        if (layoutName) {
          const customCandidates = [
            join(projectRoot, 'app', 'layouts', `${layoutName}.vue`),
            join(projectRoot, 'src', 'app', 'layouts', `${layoutName}.vue`),
            join(projectRoot, 'layouts', `${layoutName}.vue`),
            join(projectRoot, 'src', 'layouts', `${layoutName}.vue`),
          ];
          const customLayout = customCandidates.find((c) => existsSync(c));
          if (customLayout) {
            pageLayouts = [normalize(customLayout)];
          }
        }
      }
    } catch {
      // ignore
    }

    if (!pageLayouts && !explicitlyDisabledLayout && !pageMeta?.unresolvedFields?.some(item => item.field === 'layout' || item.field === '*') && hasDefaultLayout && defaultLayout) {
      pageLayouts = [normalize(defaultLayout)];
    }

    routes.push({
      path: routePath,
      filePath: normalize(file),
      type: 'page',
      framework: 'nuxt',
      params: extractRouteParams(routePath),
      layouts: pageLayouts,
      ...(pageMeta ? { nuxtPageMeta: pageMeta } : {}),
    });
  }

  return routes;
}

/**
 * Scans Nitro server API routes (server/api/** and server/routes/**).
 */
export async function scanNuxtNitroRoutes(projectRoot: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];

  const candidateDirs = [
    { dir: join(projectRoot, 'server', 'api'), prefix: '/api' },
    { dir: join(projectRoot, 'src', 'server', 'api'), prefix: '/api' },
    { dir: join(projectRoot, 'server', 'routes'), prefix: '' },
    { dir: join(projectRoot, 'src', 'server', 'routes'), prefix: '' },
  ];

  for (const { dir, prefix } of candidateDirs) {
    if (!existsSync(dir)) continue;

    const files = await collectFiles(dir);
    for (const file of files) {
      const ext = extname(file);
      if (!['.ts', '.js', '.mjs'].includes(ext)) continue;

      const rel = relative(dir, file).replace(/\\/g, '/');
      const methodSuffixMatch = rel.match(/\.(get|post|put|patch|delete|head|options)\.(?:ts|js|mjs)$/i);
      let handlers: string[] = [];

      let cleanRel = rel;
      if (methodSuffixMatch) {
        handlers = [methodSuffixMatch[1].toUpperCase()];
        cleanRel = rel.slice(0, methodSuffixMatch.index);
      } else {
        cleanRel = rel.replace(/\.(?:ts|js|mjs)$/, '');
      }

      let routePath = prefix + '/' + cleanRel;
      routePath = routePath.replace(/\/+/g, '/');
      if (routePath.endsWith('/index')) {
        routePath = routePath.slice(0, -6) || '/';
      }

      // If method was not specified by suffix, detect via AST/content or default ALL
      if (handlers.length === 0) {
        try {
          const content = await readSourceFile(file);
          const assertMatch = content.match(/assertMethod\s*\(\s*event\s*,\s*(?:'([^']+)'|"([^"]+)"|\[([\s\S]*?)\])\)/);
          if (assertMatch) {
            if (assertMatch[1] || assertMatch[2]) {
              handlers = [(assertMatch[1] || assertMatch[2]).toUpperCase()];
            } else if (assertMatch[3]) {
              handlers = Array.from(assertMatch[3].matchAll(/['"]([^'"]+)['"]/g)).map(m => m[1].toUpperCase());
            }
          }
        } catch {
          // ignore
        }
        if (handlers.length === 0) {
          handlers = ['ALL'];
        }
      }

      routes.push({
        path: routePath,
        filePath: normalize(file),
        type: 'api',
        framework: 'nuxt',
        params: extractRouteParams(routePath),
        handlers,
      });
    }
  }

  return routes;
}
