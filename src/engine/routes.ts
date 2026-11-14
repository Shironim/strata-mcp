import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import { resolveProjectOwnership } from './project-ownership';
import type { ResolveRouteEntryResult, RouteFramework, RouteInfo, RouteManifestResult, ScanRoutesOptions } from '../types';
import { extractRouteParams } from './routing/shared';
import { scanNextAppRouter } from './routing/next';
import { scanNuxtPages, scanNuxtNitroRoutes } from './routing/nuxt';
import { scanAstroPages, scanSvelteKitRoutes, scanInertiaPages } from './routing/filesystem';
import { scanVueRouterPages } from './routing/vue-router';

export { extractRouteParams } from './routing/shared';
export { extractApiHandlers } from './routing/shared';
export { extractNextSegmentConfig } from './routing/next';
export { extractNuxtPageMeta } from './routing/nuxt';
export { scanNuxtNitroRoutes } from './routing/nuxt';
export { formatRoutesAsText } from './routing/format';

/**
 * Automatically detects the routing framework used in the target project.
 */
export async function detectRouteFramework(
  targetPath: string
): Promise<{ framework: RouteFramework; baseDir: string }> {
  const normTarget = resolve(targetPath);
  const ownership = resolveProjectOwnership(join(normTarget, '__strata_route_probe__.ts'));
  const application = ownership.applicationFramework;
  if (ownership.status === 'conflict' || ownership.status === 'unverified' && ownership.ownerRoot) {
    return { framework: 'unknown', baseDir: normTarget };
  }
  const choose = (framework: RouteFramework, candidates: string[]) => {
    const baseDir = candidates.find(path => existsSync(path));
    return baseDir ? { framework, baseDir } : { framework: 'unknown' as const, baseDir: normTarget };
  };
  if (application === 'next') {
    const rel = ownership.appRoot ? relative(normTarget, ownership.appRoot) : '..';
    if (ownership.appRoot && !rel.startsWith('..') && !isAbsolute(rel)) return { framework: 'next-app', baseDir: ownership.appRoot };
    if (ownership.appRoot && (normTarget === ownership.appRoot || normTarget.startsWith(ownership.appRoot + '/'))) return { framework: 'next-app', baseDir: normTarget };
    return choose('next-pages', [join(normTarget,'pages'), join(normTarget,'src','pages')]);
  }
  if (application === 'nuxt') {
    const found = choose('nuxt', [join(normTarget,'app','pages'),join(normTarget,'src','app','pages'),join(normTarget,'pages'),join(normTarget,'src','pages')]);
    return found.framework === 'unknown' ? {framework:'nuxt',baseDir:normTarget} : found;
  }
  if (application === 'astro') return choose('astro',[join(normTarget,'src','pages'),join(normTarget,'pages')]);
  if (application === 'svelte') return choose('sveltekit',[join(normTarget,'src','routes'),join(normTarget,'routes')]);

  const hasNuxtConfig =
    existsSync(join(normTarget, 'nuxt.config.ts')) ||
    existsSync(join(normTarget, 'nuxt.config.js')) ||
    existsSync(join(normTarget, 'app.vue')) ||
    existsSync(join(normTarget, 'app', 'app.vue'));
  const hasAstroConfig =
    existsSync(join(normTarget, 'astro.config.mjs')) ||
    existsSync(join(normTarget, 'astro.config.ts'));
  const hasNextConfig =
    existsSync(join(normTarget, 'next.config.js')) ||
    existsSync(join(normTarget, 'next.config.mjs')) ||
    existsSync(join(normTarget, 'next.config.ts'));
  const hasSvelteConfig =
    existsSync(join(normTarget, 'svelte.config.js')) ||
    existsSync(join(normTarget, 'svelte.config.ts'));

  // SvelteKit routes
  for (const candidate of [join(normTarget, 'src', 'routes'), join(normTarget, 'routes')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasSvelteKitFile = files.some(
        (f) =>
          basename(f).startsWith('+page.') ||
          basename(f).startsWith('+layout.') ||
          basename(f).startsWith('+server.')
      );
      if (hasSvelteKitFile || hasSvelteConfig) {
        return { framework: 'sveltekit', baseDir: candidate };
      }
    }
  }

  // 1. Nuxt 3 & 4 (if nuxt config or app.vue is present)
  if (hasNuxtConfig && !ownership.ownerRoot) {
    for (const candidate of [
      join(normTarget, 'app', 'pages'),
      join(normTarget, 'src', 'app', 'pages'),
      join(normTarget, 'pages'),
      join(normTarget, 'src', 'pages'),
    ]) {
      if (existsSync(candidate)) {
        return { framework: 'nuxt', baseDir: candidate };
      }
    }
    if (
      existsSync(join(normTarget, 'server', 'api')) ||
      existsSync(join(normTarget, 'server', 'routes')) ||
      existsSync(join(normTarget, 'src', 'server', 'api')) ||
      existsSync(join(normTarget, 'src', 'server', 'routes'))
    ) {
      return { framework: 'nuxt', baseDir: normTarget };
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
  for (const candidate of ownership.ownerRoot ? [] : [join(normTarget, 'app'), join(normTarget, 'src', 'app')]) {
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

  // 5. Vue Router with explicit router config (src/router or router)
  const routerConfigFiles = [
    join(normTarget, 'src', 'router', 'index.ts'),
    join(normTarget, 'src', 'router', 'index.js'),
    join(normTarget, 'src', 'router.ts'),
    join(normTarget, 'src', 'router.js'),
    join(normTarget, 'router', 'index.ts'),
    join(normTarget, 'router', 'index.js'),
  ];
  const routerConfigFile = routerConfigFiles.find((f) => existsSync(f));
  if (routerConfigFile) {
    for (const candidate of [
      join(normTarget, 'src', 'views'),
      join(normTarget, 'views'),
      join(normTarget, 'src', 'pages'),
      join(normTarget, 'pages'),
    ]) {
      if (existsSync(candidate)) {
        return { framework: 'vue-router', baseDir: candidate };
      }
    }
    return { framework: 'vue-router', baseDir: dirname(routerConfigFile) };
  }

  // 6. Nuxt fallback (check for .vue files in pages directory)
  if (!ownership.ownerRoot && !hasNextConfig && !hasNuxtConfig) {
    for (const candidate of [
      join(normTarget, 'app', 'pages'),
      join(normTarget, 'src', 'app', 'pages'),
      join(normTarget, 'pages'),
      join(normTarget, 'src', 'pages'),
    ]) {
      if (existsSync(candidate)) {
        const files = await collectFiles(candidate);
        const hasVuePages = files.some((f) => f.endsWith('.vue'));
        if (hasVuePages) {
          return { framework: 'nuxt', baseDir: candidate };
        }
      }
    }
  }

  // 7. Astro fallback
  for (const candidate of [join(normTarget, 'src', 'pages'), join(normTarget, 'pages')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasAstroPages = files.some((f) => f.endsWith('.astro'));
      if (hasAstroPages) {
        return { framework: 'astro', baseDir: candidate };
      }
    }
  }

  // 8. Next.js Pages Router
  for (const candidate of ownership.ownerRoot ? [] : [join(normTarget, 'pages'), join(normTarget, 'src', 'pages')]) {
    if (existsSync(candidate)) {
      return { framework: 'next-pages', baseDir: candidate };
    }
  }

  // 9. Vue Router SPA (src/views or views convention)
  for (const candidate of [join(normTarget, 'src', 'views'), join(normTarget, 'views')]) {
    if (existsSync(candidate)) {
      const files = await collectFiles(candidate);
      const hasVueFiles = files.some((f) => f.endsWith('.vue'));
      if (hasVueFiles) {
        return { framework: 'vue-router', baseDir: candidate };
      }
    }
  }

  // 10. Standalone Inertia root Pages directory (if not Nuxt/Next)
  const rootPages = join(normTarget, 'Pages');
  if (!hasNuxtConfig && !hasNextConfig && existsSync(rootPages)) {
    return { framework: 'inertia', baseDir: rootPages };
  }

  // 11. Direct folder check if user targeted a specific routes/pages directory
  const baseName = basename(normTarget).toLowerCase();
  if (!ownership.ownerRoot && baseName === 'app') return { framework: 'next-app', baseDir: normTarget };
  if (!ownership.ownerRoot && baseName === 'pages') return { framework: 'next-pages', baseDir: normTarget };
  if (baseName === 'views') return { framework: 'vue-router', baseDir: normTarget };
  if (baseName === 'routes') return { framework: 'sveltekit', baseDir: normTarget };

  return { framework: 'unknown', baseDir: normTarget };
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
  const rootDetection = await detectRouteFramework(targetPath);
  const scopedTarget = options.scopePath ? resolve(targetPath, options.scopePath) : targetPath;
  const effectiveScanTarget =
    options.scopePath && rootDetection.framework === 'unknown' ? scopedTarget : targetPath;
  const projectContext = resolveProjectOwnership(join(effectiveScanTarget, '__strata_route_probe__.ts'));
  const detection = effectiveScanTarget === targetPath ? rootDetection : await detectRouteFramework(effectiveScanTarget);
  const framework = options.frameworkHint || detection.framework;
  let baseDir = detection.baseDir;

  // Monorepo root fallback: aggregate routes from apps/* / packages/* when root has no router
  if (framework === 'unknown' && !options.scopePath && !options.frameworkHint) {
    const subAppRoutes: RouteInfo[] = [];
    const detectedFrameworks = new Set<RouteFramework>();
    for (const parentName of ['apps', 'packages']) {
      const parentDir = join(effectiveScanTarget, parentName);
      if (!existsSync(parentDir)) continue;
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const subDir = join(parentDir, entry.name);
        const subDetection = await detectRouteFramework(subDir);
        if (subDetection.framework === 'unknown') continue;
        const subResult = await scanRoutes({ ...options, targetPath: subDir });
        if (subResult.framework !== 'unknown') detectedFrameworks.add(subResult.framework);
        subAppRoutes.push(...subResult.routes);
      }
    }
    if (subAppRoutes.length > 0 || detectedFrameworks.size > 0) {
      subAppRoutes.sort((a, b) => a.path.localeCompare(b.path));
      const summaries = computeRouteSummaries(subAppRoutes);
      const viewMode = options.view || (subAppRoutes.length > 40 && !options.prefix ? 'summary' : 'full');
      return {
        projectContext,
        framework: detectedFrameworks.size === 1 ? Array.from(detectedFrameworks)[0]! : 'unknown',
        baseDirectory: normalize(effectiveScanTarget),
        totalRoutes: subAppRoutes.length,
        routes: subAppRoutes,
        viewMode,
        summaries,
        _meta: { engine: 'in-memory-ast', durationMs: Math.round(performance.now() - startTime) },
      };
    }
  }

  if (options.frameworkHint && options.frameworkHint !== detection.framework) {
    const hintCandidates: Record<string, string[]> = {
      'next-app': [join(effectiveScanTarget, 'app'), join(effectiveScanTarget, 'src', 'app')],
      'next-pages': [join(effectiveScanTarget, 'pages'), join(effectiveScanTarget, 'src', 'pages')],
      'nuxt': [
        join(effectiveScanTarget, 'app', 'pages'),
        join(effectiveScanTarget, 'src', 'app', 'pages'),
        join(effectiveScanTarget, 'pages'),
        join(effectiveScanTarget, 'src', 'pages'),
      ],
      'astro': [join(effectiveScanTarget, 'src', 'pages'), join(effectiveScanTarget, 'pages')],
      'inertia': [
        join(effectiveScanTarget, 'resources', 'js', 'Pages'),
        join(effectiveScanTarget, 'resources', 'js', 'pages'),
        join(effectiveScanTarget, 'resources', 'scripts', 'Pages'),
        join(effectiveScanTarget, 'src', 'pages'),
      ],
      'vue-router': [
        join(effectiveScanTarget, 'src', 'views'),
        join(effectiveScanTarget, 'views'),
        join(effectiveScanTarget, 'src', 'pages'),
        join(effectiveScanTarget, 'pages'),
      ],
      'sveltekit': [join(effectiveScanTarget, 'src', 'routes'), join(effectiveScanTarget, 'routes')],
    };
    const candidates = hintCandidates[options.frameworkHint];
    if (candidates) {
      const found = candidates.find((c) => existsSync(c));
      if (found) {
        baseDir = found;
      }
    }
  }

  let routes: RouteInfo[] = [];
  const unresolvedOwnedFramework = framework === 'unknown' && Boolean(projectContext.ownerRoot);
  if (unresolvedOwnedFramework) projectContext.diagnostics.push({ code: 'ROUTE_FRAMEWORK_UNVERIFIED',
    reason: 'No unambiguous supported router is established for this owner. Select a specific application package or provide an explicit parser framework hint; empty routes do not prove absence.' });

  if (!unresolvedOwnedFramework) switch (framework) {
    case 'next-app':
      routes = await scanNextAppRouter(baseDir);
      break;
    case 'nuxt': {
      routes = baseDir !== effectiveScanTarget || basename(baseDir) === 'pages'
        ? await scanNuxtPages(baseDir, effectiveScanTarget) : [];
      const nitroRoutes = await scanNuxtNitroRoutes(effectiveScanTarget);
      routes.push(...nitroRoutes);
      break;
    }
    case 'astro':
      routes = await scanAstroPages(baseDir);
      break;
    case 'inertia':
      routes = await scanInertiaPages(baseDir);
      break;
    case 'vue-router':
      routes = await scanVueRouterPages(baseDir, effectiveScanTarget);
      break;
    case 'sveltekit':
      routes = await scanSvelteKitRoutes(baseDir);
      break;
    case 'next-pages':
    default: {
      let scanTarget = baseDir;
      if (framework === 'unknown') {
        const candidatePageDirs = [
          join(baseDir, 'src', 'pages'),
          join(baseDir, 'pages'),
          join(baseDir, 'src', 'views'),
          join(baseDir, 'views'),
          join(baseDir, 'src', 'routes'),
          join(baseDir, 'routes'),
        ];
        const matchedCandidate = candidatePageDirs.find((dir) => existsSync(dir));
        if (matchedCandidate) {
          scanTarget = matchedCandidate;
        } else {
          // No standard page directory found; avoid scanning root to prevent false positive route pollution
          break;
        }
      }

      const files = await collectFiles(scanTarget);
      for (const file of files) {
        const ext = extname(file);
        if (!['.tsx', '.jsx', '.js', '.ts', '.vue'].includes(ext)) continue;
        const b = basename(file);
        if (b.startsWith('_')) continue; // skip _app, _document

        const rel = relative(scanTarget, file).replace(/\\/g, '/');
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

  if (projectContext.ownerRoot) {
    const before = routes.length;
    routes = routes.filter(route => resolveProjectOwnership(route.filePath).ownerRoot === projectContext.ownerRoot);
    if (routes.length !== before) projectContext.diagnostics.push({ code: 'NESTED_ROUTE_OWNERS_EXCLUDED',
      reason: `${before - routes.length} route candidates belong to another package/config owner; scan those applications separately.` });
  }

  if (options.excludeDirs?.length) {
    const allowed = new Set(await collectFiles(targetPath, { excludeDirs: options.excludeDirs }));
    routes = routes.filter(r => allowed.has(r.filePath));
  }

  // Filter by scopePath if provided
  if (options.scopePath) {
    const absScope = resolve(targetPath, options.scopePath);
    routes = routes.filter((r) => {
      const rel = relative(absScope, r.filePath);
      return !rel.startsWith('..') && !isAbsolute(rel);
    });
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
    projectContext,
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
      return '__OPT_CATCH_ALL__';
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

    // 5. Vue router colon param :param or :pathMatch(.*)*
    const colonDynamic = seg.match(/^:([A-Za-z0-9_$]+)(\(.*?\))?(\*|\+)?$/);
    if (colonDynamic) {
      paramNames.push(colonDynamic[1]);
      return colonDynamic[3] === '*' ? '(.*)' : '([^/]+)';
    }

    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  // Handle leading slash
  let regexStr = '^' + regexSegments.join('/');
  if (regexStr.includes('/__OPT_CATCH_ALL__')) {
    regexStr = regexStr.replace('/__OPT_CATCH_ALL__', '(?:/(.*))?');
  } else if (regexStr.includes('__OPT_CATCH_ALL__')) {
    regexStr = regexStr.replace('__OPT_CATCH_ALL__', '(?:/?(.*))?');
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
