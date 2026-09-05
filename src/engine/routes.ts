import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import type {
  ResolveRouteEntryOptions,
  ResolveRouteEntryResult,
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

  const hasNuxtConfig =
    existsSync(join(normTarget, 'nuxt.config.ts')) ||
    existsSync(join(normTarget, 'nuxt.config.js')) ||
    existsSync(join(normTarget, 'app.vue'));
  const hasAstroConfig =
    existsSync(join(normTarget, 'astro.config.mjs')) ||
    existsSync(join(normTarget, 'astro.config.ts'));
  const hasNextConfig =
    existsSync(join(normTarget, 'next.config.js')) ||
    existsSync(join(normTarget, 'next.config.mjs')) ||
    existsSync(join(normTarget, 'next.config.ts'));

  // 1. Nuxt 3 (if nuxt config or app.vue is present)
  if (hasNuxtConfig) {
    for (const candidate of [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
      if (existsSync(candidate)) {
        return { framework: 'nuxt', baseDir: candidate };
      }
    }
  }

  // 2. Astro (if astro config is present)
  if (hasAstroConfig) {
    for (const candidate of [join(normTarget, 'src', 'pages'), join(normTarget, 'pages')]) {
      if (existsSync(candidate)) {
        return { framework: 'astro', baseDir: candidate };
      }
    }
  }

  // 3. Next.js App Router
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

  // 4. Inertia.js (Laravel + Vue/React in resources/js/Pages)
  for (const candidate of [
    join(normTarget, 'resources', 'js', 'Pages'),
    join(normTarget, 'resources', 'js', 'pages'),
  ]) {
    if (existsSync(candidate)) {
      return { framework: 'inertia', baseDir: candidate };
    }
  }

  // 5. Nuxt 3 fallback (check for .vue files in pages directory)
  if (!hasNextConfig) {
    for (const candidate of [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
      if (existsSync(candidate)) {
        const files = await collectFiles(candidate);
        const hasVuePages = files.some((f) => f.endsWith('.vue'));
        if (hasVuePages) {
          return { framework: 'nuxt', baseDir: candidate };
        }
      }
    }
  }

  // 6. Astro fallback
  for (const candidate of [join(normTarget, 'src', 'pages'), join(normTarget, 'pages')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasAstroPages = files.some((f) => f.endsWith('.astro'));
      if (hasAstroPages) {
        return { framework: 'astro', baseDir: candidate };
      }
    }
  }

  // 7. Next.js Pages Router
  for (const candidate of [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
    if (existsSync(candidate)) {
      return { framework: 'next-pages', baseDir: candidate };
    }
  }

  // 8. Standalone Inertia root Pages directory (if not Nuxt/Next)
  const rootPages = join(normTarget, 'Pages');
  if (!hasNuxtConfig && !hasNextConfig && existsSync(rootPages)) {
    return { framework: 'inertia', baseDir: rootPages };
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

    // Ignore sub-components, private partials, and files starting with _
    // E.g. "Penjualan/Partials/CustomerSection.vue", "Partials/...", "Components/...", "_Modal.vue"
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

    // Standard Inertia page naming: e.g. "Dashboard" -> "/dashboard", "Penjualan/Index" -> "/penjualan"
    // Applies Laravel RESTful resource conventions:
    // - "Services/Show" or "Services/Detail" -> "/services/[id]"
    // - "Services/Edit" -> "/services/[id]/edit"
    // - Retains custom brackets if present: "Services/[slug]" -> "/services/[slug]"
    const mappedSegments: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      if (seg === 'Index') {
        continue;
      } else if (isLast && (seg === 'Show' || seg === 'Detail')) {
        mappedSegments.push('[id]');
      } else if (isLast && seg === 'Edit') {
        mappedSegments.push('[id]', 'edit');
      } else if (seg.startsWith('[') && seg.endsWith(']')) {
        mappedSegments.push(seg);
      } else {
        mappedSegments.push(seg.toLowerCase());
      }
    }

    let routePath = '/' + mappedSegments.filter(Boolean).join('/');
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
 * Computes top-level namespace summaries for a list of routes.
 */
export function computeRouteSummaries(routes: RouteInfo[]): Record<string, number> {
  const summaries: Record<string, number> = {};
  for (const r of routes) {
    const segments = r.path.split('/').filter(Boolean);
    const topLevel = segments.length > 0 ? `/${segments[0]}` : '/';
    summaries[topLevel] = (summaries[topLevel] || 0) + 1;
  }
  return summaries;
}

/**
 * Public facade: scans a project directory to discover its file-based route topology.
 */
export async function scanRoutes(options: ScanRoutesOptions): Promise<RouteManifestResult> {
  const startTime = performance.now();
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

  // Filter by prefix if provided
  if (options.prefix) {
    const normPrefix = options.prefix.startsWith('/') ? options.prefix : `/${options.prefix}`;
    routes = routes.filter((r) => r.path === normPrefix || r.path.startsWith(normPrefix.endsWith('/') ? normPrefix : `${normPrefix}/`));
  }

  // Sort routes alphabetically by path
  routes.sort((a, b) => a.path.localeCompare(b.path));

  const summaries = computeRouteSummaries(routes);
  const viewMode = options.view || (routes.length > 40 && !options.prefix ? 'summary' : 'full');
  const durationMs = Math.round(performance.now() - startTime);

  return {
    framework,
    baseDirectory: normalize(baseDir),
    totalRoutes: routes.length,
    routes,
    viewMode,
    summaries,
    _meta: {
      engine: 'in-memory-ast',
      durationMs,
    },
  };
}

/**
 * Formats a RouteManifestResult into a token-efficient, human-readable summary.
 */
export function formatRoutesAsText(result: RouteManifestResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Route Manifest (${result.framework})${metaBadge}`,
    `Base Directory: ${result.baseDirectory}`,
    `Total Routes: ${result.totalRoutes}`,
  ];

  if (result.routes.length === 0) {
    lines.push('\n(No routes found matching query)');
    return lines.join('\n');
  }

  if (result.viewMode === 'summary' && result.summaries) {
    lines.push('\nModule & Domain Breakdown (Summary Mode):');
    const sortedEntries = Object.entries(result.summaries).sort((a, b) => b[1] - a[1]);
    for (const [prefix, count] of sortedEntries) {
      lines.push(`  • ${prefix.padEnd(16)} : ${count} routes`);
    }
    lines.push('');
    lines.push('(Tip: Use prefix="/domain" to drill down, or view="full" to expand all routes)');
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

/**
 * Normalizes a user-provided route path string.
 */
export function normalizeRoutePath(input: string): string {
  let p = input.trim().replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Converts a framework route pattern (e.g. /products/[id], /blog/[...slug]) to a RegExp with named capture groups.
 */
function routePatternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pattern.split('/');

  const regexSegments = segments.map((seg) => {
    if (!seg) return '';

    // 1. Optional catch-all [[...param]]
    const optCatchAll = seg.match(/^\[\[\.\.\.([A-Za-z0-9_$]+)\]\]$/);
    if (optCatchAll) {
      paramNames.push(optCatchAll[1]);
      return '(?:/(.*))?';
    }

    // 2. Catch-all [...param]
    const catchAll = seg.match(/^\[\.\.\.([A-Za-z0-9_$]+)\]$/);
    if (catchAll) {
      paramNames.push(catchAll[1]);
      return '(.+)';
    }

    // 3. Dynamic param [param]
    const dynamic = seg.match(/^\[([A-Za-z0-9_$]+)\]$/);
    if (dynamic) {
      paramNames.push(dynamic[1]);
      return '([^/]+)';
    }

    // 4. Nuxt 2 style dynamic param _param
    const nuxt2Dynamic = seg.match(/^_([A-Za-z0-9_$]+)$/);
    if (nuxt2Dynamic) {
      paramNames.push(nuxt2Dynamic[1]);
      return '([^/]+)';
    }

    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  // Handle leading slash
  let regexStr = '^' + regexSegments.join('/');
  // If pattern has optional catch-all at end, adjust slash handling
  if (pattern.includes('[[...')) {
    regexStr = '^' + regexSegments.filter(Boolean).join('/');
  }
  regexStr += '$';

  return {
    regex: new RegExp(regexStr),
    paramNames,
  };
}

/**
 * Resolves a given URL route path to its corresponding page component file, framework, and layout wrappers.
 */
export async function resolveRouteEntry(
  targetPath: string,
  routePath: string,
  frameworkHint?: RouteFramework
): Promise<ResolveRouteEntryResult> {
  const normalizedInput = normalizeRoutePath(routePath);
  const manifest = await scanRoutes({ targetPath, frameworkHint });

  if (manifest.routes.length === 0) {
    return {
      matched: false,
      routePath: normalizedInput,
      availableRoutes: [],
    };
  }

  // Filter page routes first, fallback to all routes
  const pageRoutes = manifest.routes.filter((r) => r.type === 'page');
  const candidateRoutes = pageRoutes.length > 0 ? pageRoutes : manifest.routes;

  // 1. Exact string match
  const exactMatch = candidateRoutes.find(
    (r) => normalizeRoutePath(r.path) === normalizedInput
  );
  if (exactMatch) {
    return {
      matched: true,
      routePath: normalizedInput,
      matchedPattern: exactMatch.path,
      filePath: exactMatch.filePath,
      framework: exactMatch.framework,
      layouts: exactMatch.layouts,
      params: {},
      availableRoutes: manifest.routes.map((r) => r.path),
    };
  }

  // 2. Pattern match (ordered by specificity: fixed segments -> single dynamic -> catch-all)
  const sortedCandidates = [...candidateRoutes].sort((a, b) => {
    const aParams = a.params.length;
    const bParams = b.params.length;
    if (aParams !== bParams) return aParams - bParams;
    return b.path.length - a.path.length;
  });

  for (const candidate of sortedCandidates) {
    if (candidate.params.length === 0) continue;

    const { regex, paramNames } = routePatternToRegex(candidate.path);
    const match = normalizedInput.match(regex);
    if (match) {
      const params: Record<string, string> = {};
      paramNames.forEach((name, idx) => {
        if (match[idx + 1] !== undefined) {
          params[name] = match[idx + 1];
        }
      });

      return {
        matched: true,
        routePath: normalizedInput,
        matchedPattern: candidate.path,
        filePath: candidate.filePath,
        framework: candidate.framework,
        layouts: candidate.layouts,
        params,
        availableRoutes: manifest.routes.map((r) => r.path),
      };
    }
  }

  return {
    matched: false,
    routePath: normalizedInput,
    availableRoutes: manifest.routes.map((r) => r.path),
  };
}
