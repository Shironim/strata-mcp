import { readSourceFile } from '../source-file';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { collectFiles } from '../collector';
import type { RouteInfo } from '../../types';
import { extractRouteParams } from './shared';

/**
 * Scans a Vue Router configuration file (e.g. src/router/index.ts) using TypeScript AST.
 */
export async function scanVueRouterFromConfig(routerConfigFile: string): Promise<RouteInfo[] | null> {
  let content: string;
  try {
    content = await readSourceFile(routerConfigFile);
  } catch {
    return null;
  }
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(routerConfigFile, content, ts.ScriptTarget.Latest, true);
  } catch {
    return null;
  }
  const routes: RouteInfo[] = [];
  const dir = dirname(routerConfigFile);

  const importMap = new Map<string, string>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
      const modulePath = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        importMap.set(statement.importClause.name.text, modulePath);
      }
      if (statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const el of statement.importClause.namedBindings.elements) {
          importMap.set(el.name.text, modulePath);
        }
      }
    }
  }

  function resolveComponentPath(specifier: string): string {
    const candidate = resolve(dir, specifier);
    for (const ext of ['', '.vue', '.ts', '.js', '.tsx', '.jsx']) {
      const p = candidate + ext;
      if (existsSync(p)) return normalize(p);
    }
    return normalize(candidate);
  }

  function parseRouteNode(node: ts.ObjectLiteralExpression, parentPath = ''): void {
    let pathVal: string | undefined;
    let compVal: string | undefined;
    let redirectVal: string | undefined;
    let childrenNode: ts.ArrayLiteralExpression | undefined;
    let isRouteObj = false;

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const propName = prop.name.getText(sf).replace(/['"]/g, '');
      if (propName === 'path' && ts.isStringLiteral(prop.initializer)) {
        pathVal = prop.initializer.text;
        isRouteObj = true;
      } else if (propName === 'redirect' && ts.isStringLiteral(prop.initializer)) {
        redirectVal = prop.initializer.text;
        isRouteObj = true;
      } else if (propName === 'component') {
        isRouteObj = true;
        if (ts.isIdentifier(prop.initializer)) {
          const mod = importMap.get(prop.initializer.text);
          if (mod) compVal = mod;
        } else {
          prop.initializer.forEachChild((child) => {
            if (ts.isCallExpression(child)) {
              if (child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments.length > 0) {
                const arg = child.arguments[0];
                if (ts.isStringLiteral(arg)) {
                  compVal = arg.text;
                }
              }
            }
          });
        }
      } else if (propName === 'children' && ts.isArrayLiteralExpression(prop.initializer)) {
        childrenNode = prop.initializer;
      }
    }

    if (isRouteObj && pathVal !== undefined) {
      const fullPath = parentPath
        ? (parentPath.endsWith('/') ? parentPath : parentPath + '/') + (pathVal.startsWith('/') ? pathVal.slice(1) : pathVal)
        : pathVal;
      const resolvedFile = compVal ? resolveComponentPath(compVal) : normalize(routerConfigFile);

      routes.push({
        path: fullPath,
        filePath: resolvedFile,
        type: 'page',
        framework: 'vue-router',
        params: extractRouteParams(fullPath),
        ...(redirectVal ? { redirect: redirectVal } : {}),
      });

      if (childrenNode) {
        for (const childEl of childrenNode.elements) {
          if (ts.isObjectLiteralExpression(childEl)) {
            parseRouteNode(childEl, fullPath);
          }
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      parseRouteNode(node);
    }
    node.forEachChild(visit);
  }

  visit(sf);
  return routes.length > 0 ? routes : null;
}

/**
 * Scans a Vue Router SPA directory or explicit router config file and builds its route manifest.
 */
export async function scanVueRouterPages(baseDir: string, projectRoot?: string): Promise<RouteInfo[]> {
  const normRoot = projectRoot ? resolve(projectRoot) : dirname(baseDir);
  const routerConfigFiles = [
    join(normRoot, 'src', 'router', 'index.ts'),
    join(normRoot, 'src', 'router', 'index.js'),
    join(normRoot, 'src', 'router.ts'),
    join(normRoot, 'src', 'router.js'),
    join(normRoot, 'router', 'index.ts'),
    join(normRoot, 'router', 'index.js'),
  ];
  for (const cfg of routerConfigFiles) {
    if (existsSync(cfg)) {
      const fromConfig = await scanVueRouterFromConfig(cfg);
      if (fromConfig && fromConfig.length > 0) {
        return fromConfig;
      }
    }
  }

  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.vue') && !file.endsWith('.tsx') && !file.endsWith('.jsx')) continue;

    const rel = relative(baseDir, file).replace(/\\/g, '/');
    const cleanRel = rel.replace(/\.[a-z0-9]+$/, '');

    const segments = cleanRel.split('/');
    const isPrivateOrPartial = segments.some((seg) => {
      const lower = seg.toLowerCase();
      return (
        lower === 'partials' ||
        lower === 'components' ||
        lower === 'private' ||
        seg.startsWith('_')
      );
    });
    if (isPrivateOrPartial) continue;

    const mappedSegments: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      let seg = segments[i];
      if (seg.endsWith('View') && seg.length > 4) {
        seg = seg.slice(0, -4);
      }
      if (seg.endsWith('Page') && seg.length > 4) {
        seg = seg.slice(0, -4);
      }
      if (seg === 'Index' || seg.toLowerCase() === 'index') {
        continue;
      }
      mappedSegments.push(seg.toLowerCase());
    }

    let routePath = '/' + mappedSegments.filter(Boolean).join('/');
    if (!routePath) routePath = '/';

    routes.push({
      path: routePath,
      filePath: normalize(file),
      type: 'page',
      framework: 'vue-router',
      params: extractRouteParams(routePath),
    });
  }

  return routes;
}
