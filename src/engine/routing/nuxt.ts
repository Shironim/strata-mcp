import { parseTypeScript } from '../source-parser';
import { readSourceFile } from '../source-file';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
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
export async function scanNuxtPages(
  baseDir: string,
  projectRoot: string,
  layoutRoots: readonly string[] = [projectRoot]
): Promise<RouteInfo[]> {
  if (!existsSync(baseDir)) return [];
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  const findLayoutFile = (layoutName: string): string | undefined => {
    for (const root of layoutRoots) {
      const candidates = [
        join(root, 'app', 'layouts', `${layoutName}.vue`),
        join(root, 'src', 'app', 'layouts', `${layoutName}.vue`),
        join(root, 'layouts', `${layoutName}.vue`),
        join(root, 'src', 'layouts', `${layoutName}.vue`),
      ];
      const match = candidates.find((c) => existsSync(c));
      if (match) return match;
    }
    return undefined;
  };

  const defaultLayout = findLayoutFile('default');
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
          const customLayout = findLayoutFile(layoutName);
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

const NUXT_CONFIG_FILES = [
  'nuxt.config.ts',
  'nuxt.config.js',
  'nuxt.config.mjs',
  'nuxt.config.mts',
  'nuxt.config.cjs',
];

function extractExtendsPathsFromConfig(projectRoot: string): string[] {
  const configName = NUXT_CONFIG_FILES.find((f) => existsSync(join(projectRoot, f)));
  if (!configName) return [];

  const configPath = join(projectRoot, configName);
  let content = '';
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  if (!content.includes('extends')) return [];

  const sf = parseTypeScript(configName, content, ts.ScriptKind.TS);
  const found: string[] = [];

  const collectStrings = (node: ts.Expression): void => {
    const unwrapped = unwrapExpression(node);
    if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
      found.push(unwrapped.text);
    } else if (ts.isArrayLiteralExpression(unwrapped)) {
      for (const el of unwrapped.elements) {
        if (ts.isExpression(el)) collectStrings(el);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && staticPropertyName(node.name) === 'extends') {
      collectStrings(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return found;
}

/**
 * Discovers local Nuxt Layer root directories from `nuxt.config.*` `extends`
 * and Nuxt's auto-scanned `layers/*` convention.
 */
export function discoverNuxtLayerRoots(projectRoot: string): string[] {
  const normRoot = normalize(resolve(projectRoot));
  const seen = new Set<string>([normRoot]);
  const layers: string[] = [];

  const addCandidate = (candidateDir: string): void => {
    const resolved = normalize(resolve(candidateDir));
    if (seen.has(resolved) || !existsSync(resolved)) return;
    try {
      if (!statSync(resolved).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(resolved);
    layers.push(resolved);
  };

  // 1. Explicit local layers from nuxt.config.* `extends`
  for (const extEntry of extractExtendsPathsFromConfig(normRoot)) {
    if (!extEntry || /^[a-z]+:/i.test(extEntry) || extEntry.startsWith('@')) continue;
    addCandidate(resolve(normRoot, extEntry));
  }

  // 2. Auto-discovered local layers in `<projectRoot>/layers/*`
  const layersDir = join(normRoot, 'layers');
  if (existsSync(layersDir)) {
    try {
      const entries = readdirSync(layersDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        addCandidate(join(layersDir, entry.name));
      }
    } catch {
      // ignore unreadable layers directory
    }
  }

  return layers;
}

/**
 * Scans all page and Nitro API routes across a Nuxt project root and its local Nuxt Layers.
 * Root project routes take precedence over layer routes when paths collide.
 */
export async function scanNuxtWorkspaceRoutes(projectRoot: string): Promise<RouteInfo[]> {
  const normRoot = normalize(resolve(projectRoot));
  const layerRoots = discoverNuxtLayerRoots(normRoot);
  const allRoots = [normRoot, ...layerRoots];

  const routes: RouteInfo[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (items: RouteInfo[]): void => {
    for (const item of items) {
      const key = `${item.type}:${item.path}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      routes.push(item);
    }
  };

  for (const root of allRoots) {
    const pageDirCandidates = [
      join(root, 'app', 'pages'),
      join(root, 'src', 'app', 'pages'),
      join(root, 'pages'),
      join(root, 'src', 'pages'),
    ];
    const pagesDir = pageDirCandidates.find((c) => existsSync(c));
    if (pagesDir) {
      pushUnique(await scanNuxtPages(pagesDir, root, allRoots));
    }
    pushUnique(await scanNuxtNitroRoutes(root));
  }

  return routes;
}
