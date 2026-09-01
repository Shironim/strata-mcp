import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import type {
  RouteFramework,
  RouteInfo,
  RouteManifestResult,
  RouteParam,
  RouteType,
  ScanRoutesOptions,
} from '../types';

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
  }

  return params;
}

/**
 * Extracts exported HTTP methods (GET, POST, etc.) from an API route file.
 */
export async function extractApiHandlers(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const handlers: string[] = [];
    const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    for (const method of httpMethods) {
      const regex = new RegExp(
        `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`
      );
      if (regex.test(content)) {
        handlers.push(method);
      }
    }
    return handlers.length > 0 ? handlers : ['ALL'];
  } catch {
    return [];
  }
}

/**
 * Automatically detects the routing framework used in the target project.
 */
export async function detectRouteFramework(
  targetPath: string
): Promise<{ framework: RouteFramework; baseDir: string }> {
  const normTarget = resolve(targetPath);

  // 1. Next.js App Router
  for (const candidate of [join(normTarget, 'app'), join(normTarget, 'src', 'app')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasAppRouterFile = files.some(
        (f) =>
          basename(f).startsWith('page.') ||
          basename(f).startsWith('layout.') ||
          basename(f).startsWith('route.')
      );
      if (hasAppRouterFile) {
        return { framework: 'next-app', baseDir: candidate };
      }
    }
  }

  // 2. Inertia.js (Laravel + Vue/React)
  for (const candidate of [
    join(normTarget, 'resources', 'js', 'Pages'),
    join(normTarget, 'resources', 'js', 'pages'),
    join(normTarget, 'Pages'),
  ]) {
    if (existsSync(candidate)) {
      return { framework: 'inertia', baseDir: candidate };
    }
  }

  // 3. Nuxt 3
  for (const candidate of [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasVuePages = files.some((f) => f.endsWith('.vue'));
      if (hasVuePages) {
        return { framework: 'nuxt', baseDir: candidate };
      }
    }
  }

  // 4. Astro
  for (const candidate of [join(normTarget, 'src', 'pages'), join(normTarget, 'pages')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasAstroPages = files.some((f) => f.endsWith('.astro'));
      if (hasAstroPages) {
        return { framework: 'astro', baseDir: candidate };
      }
    }
  }

  // 5. Next.js Pages Router
  for (const candidate of [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
    if (existsSync(candidate)) {
      return { framework: 'next-pages', baseDir: candidate };
    }
  }

  // 6. Direct folder check if user targeted a specific routes/pages directory
  const baseName = basename(normTarget).toLowerCase();
  if (baseName === 'app') return { framework: 'next-app', baseDir: normTarget };
  if (baseName === 'pages') return { framework: 'next-pages', baseDir: normTarget };

  return { framework: 'unknown', baseDir: normTarget };
}

/**
 * Scans a Next.js App Router directory and builds its route manifest.
 */
async function scanNextAppRouter(baseDir: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  // Index all layout files
  const layoutFiles = files.filter((f) => {
    const b = basename(f);
    return b.startsWith('layout.') && ['.tsx', '.jsx', '.js', '.ts'].includes(extname(f));
  });

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
    const b = basename(file);
    const ext = extname(file);
    const fileDir = dirname(file);
    const relDir = relative(baseDir, fileDir).replace(/\\/g, '/');

    // Filter out route groups e.g. (marketing), (auth) from URL path
    const urlSegments = relDir
      ? relDir
          .split('/')
          .filter((seg) => !seg.startsWith('(') || !seg.endsWith(')'))
      : [];

    if (b.startsWith('page.') && ['.tsx', '.jsx', '.js', '.ts'].includes(ext)) {
      const routePath = '/' + urlSegments.join('/');
      routes.push({
        path: routePath === '//' ? '/' : routePath || '/',
        filePath: normalize(file),
        type: 'page',
        framework: 'next-app',
        params: extractRouteParams(routePath),
        layouts: getLayoutChain(fileDir),
      });
    } else if (b.startsWith('route.') && ['.ts', '.js'].includes(ext)) {
      const routePath = '/' + urlSegments.join('/');
      const handlers = await extractApiHandlers(file);
      routes.push({
        path: routePath === '//' ? '/' : routePath || '/',
        filePath: normalize(file),
        type: 'api',
        framework: 'next-app',
        params: extractRouteParams(routePath),
        handlers,
      });
    }
  }

  return routes;
}

/**
 * Scans a Nuxt 3 pages directory and builds its route manifest.
 */
async function scanNuxtPages(baseDir: string, projectRoot: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  // Check default layout
  const defaultLayout = join(projectRoot, 'layouts', 'default.vue');
  const hasDefaultLayout = existsSync(defaultLayout);

  for (const file of files) {
    if (!file.endsWith('.vue')) continue;

    const rel = relative(baseDir, file).replace(/\\/g, '/');
    let routePath = '/' + rel.replace(/\.vue$/, '');

    // Convert index to /
    if (routePath.endsWith('/index')) {
      routePath = routePath.slice(0, -6) || '/';
    }

    let pageLayouts: string[] | undefined;
    try {
      const content = await fs.readFile(file, 'utf8');
      const layoutMatch = content.match(/layout:\s*['"]([^'"]+)['"]/);
      if (layoutMatch) {
        const customLayout = join(projectRoot, 'layouts', `${layoutMatch[1]}.vue`);
        if (existsSync(customLayout)) {
          pageLayouts = [normalize(customLayout)];
        }
      }
    } catch {
      // ignore
    }

    if (!pageLayouts && hasDefaultLayout) {
      pageLayouts = [normalize(defaultLayout)];
    }

    routes.push({
      path: routePath,
      filePath: normalize(file),
      type: 'page',
      framework: 'nuxt',
      params: extractRouteParams(routePath),
      layouts: pageLayouts,
    });
  }

  return routes;
}

/**
 * Scans an Astro src/pages directory and builds its route manifest.
 */
async function scanAstroPages(baseDir: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  for (const file of files) {
    const ext = extname(file);
    if (!['.astro', '.md', '.mdx', '.ts', '.js'].includes(ext)) continue;

    const rel = relative(baseDir, file).replace(/\\/g, '/');
    let routePath = '/' + rel.replace(new RegExp(`${ext}$`), '');

    if (routePath.endsWith('/index')) {
      routePath = routePath.slice(0, -6) || '/';
    }

    const isApi = ext === '.ts' || ext === '.js';
    const handlers = isApi ? await extractApiHandlers(file) : undefined;

    routes.push({
      path: routePath,
      filePath: normalize(file),
      type: isApi ? 'api' : 'page',
      framework: 'astro',
      params: extractRouteParams(routePath),
      handlers,
    });
  }

  return routes;
}

/**
 * Scans an Inertia.js Pages directory and builds its route manifest.
 */
async function scanInertiaPages(baseDir: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.vue') && !file.endsWith('.tsx') && !file.endsWith('.jsx')) continue;

    const rel = relative(baseDir, file).replace(/\\/g, '/');
    const cleanRel = rel.replace(/\.[a-z0-9]+$/, '');

    // Standard Inertia page naming: e.g. "Dashboard" -> "/dashboard", "Penjualan/Index" -> "/penjualan"
    let routePath =
      '/' +
      cleanRel
        .split('/')
        .map((seg) => (seg === 'Index' ? '' : seg.toLowerCase()))
        .filter(Boolean)
        .join('/');

    if (!routePath) routePath = '/';

    // Extract layout imported inside the Inertia page
    let layouts: string[] | undefined;
    try {
      const content = await fs.readFile(file, 'utf8');
      const layoutImportMatch = content.match(/import\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]*Layout[^'"]*)['"]/);
      if (layoutImportMatch) {
        layouts = [layoutImportMatch[2]];
      }
    } catch {
      // ignore
    }

    routes.push({
      path: routePath,
      filePath: normalize(file),
      type: 'page',
      framework: 'inertia',
      params: extractRouteParams(routePath),
      layouts,
    });
  }

  return routes;
}

/**
 * Public facade: scans a project directory to discover its file-based route topology.
 */
export async function scanRoutes(options: ScanRoutesOptions): Promise<RouteManifestResult> {
  const targetPath = resolve(options.targetPath);
  const detection = await detectRouteFramework(targetPath);
  const framework = options.frameworkHint || detection.framework;
  const baseDir = detection.baseDir;

  let routes: RouteInfo[] = [];

  switch (framework) {
    case 'next-app':
      routes = await scanNextAppRouter(baseDir);
      break;
    case 'nuxt':
      routes = await scanNuxtPages(baseDir, targetPath);
      break;
    case 'astro':
      routes = await scanAstroPages(baseDir);
      break;
    case 'inertia':
      routes = await scanInertiaPages(baseDir);
      break;
    case 'next-pages':
    default: {
      const files = await collectFiles(baseDir);
      for (const file of files) {
        const ext = extname(file);
        if (!['.tsx', '.jsx', '.js', '.ts', '.vue'].includes(ext)) continue;
        const b = basename(file);
        if (b.startsWith('_')) continue; // skip _app, _document

        const rel = relative(baseDir, file).replace(/\\/g, '/');
        let routePath = '/' + rel.replace(new RegExp(`${ext}$`), '');
        if (routePath.endsWith('/index')) routePath = routePath.slice(0, -6) || '/';

        const isApi = routePath.startsWith('/api/') || routePath === '/api';
        routes.push({
          path: routePath,
          filePath: normalize(file),
          type: isApi ? 'api' : 'page',
          framework,
          params: extractRouteParams(routePath),
        });
      }
      break;
    }
  }

  // Sort routes alphabetically by path
  routes.sort((a, b) => a.path.localeCompare(b.path));

  return {
    framework,
    baseDirectory: normalize(baseDir),
    totalRoutes: routes.length,
    routes,
  };
}

/**
 * Formats a RouteManifestResult into a token-efficient, human-readable summary.
 */
export function formatRoutesAsText(result: RouteManifestResult): string {
  const lines: string[] = [
    `Route Manifest (${result.framework})`,
    `Base Directory: ${result.baseDirectory}`,
    `Total Routes: ${result.totalRoutes}`,
  ];

  if (result.routes.length === 0) {
    lines.push('\n(No routes found)');
    return lines.join('\n');
  }

  lines.push('\nRoutes:');
  for (const r of result.routes) {
    const paramStr =
      r.params.length > 0 ? ` (params: ${r.params.map((p) => p.name).join(', ')})` : '';
    const handlerStr = r.handlers ? ` (handlers: ${r.handlers.join(', ')})` : '';
    lines.push(`  ${r.path} [${r.type}]${paramStr}${handlerStr}`);
    lines.push(`    File: ${r.filePath}`);
    if (r.layouts && r.layouts.length > 0) {
      lines.push(`    Layouts: ${r.layouts.join(', ')}`);
    }
  }

  return lines.join('\n');
}
