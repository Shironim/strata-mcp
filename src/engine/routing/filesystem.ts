import { readSourceFile } from '../source-file';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';
import { collectFiles } from '../collector';
import type { RouteInfo, RouteType } from '../../types';
import { extractRouteParams, extractApiHandlers } from './shared';

/**
 * Scans an Astro src/pages directory and builds its route manifest.
 */
export async function scanAstroPages(baseDir: string): Promise<RouteInfo[]> {
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
 * Scans a SvelteKit routes directory (+page.svelte, +layout.svelte, +server.ts) and builds its route manifest.
 */
export async function scanSvelteKitRoutes(baseDir: string): Promise<RouteInfo[]> {
  const files = await collectFiles(baseDir);
  const routes: RouteInfo[] = [];

  // Index all layout files
  const layoutFiles = files.filter((f) => {
    const b = basename(f);
    return b.startsWith('+layout.') && (b.endsWith('.svelte') || b.endsWith('.ts') || b.endsWith('.js'));
  });

  function getLayoutChain(fileDir: string): string[] {
    const chain: string[] = [];
    let cur = fileDir;
    while (cur.startsWith(baseDir)) {
      const match = layoutFiles.find((l) => dirname(l) === cur && basename(l).endsWith('.svelte'));
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
    if (!b.startsWith('+page.') && !b.startsWith('+layout.') && !b.startsWith('+server.')) {
      continue;
    }

    const fileDir = dirname(file);
    const relDir = relative(baseDir, fileDir).replace(/\\/g, '/');

    const rawSegments = relDir ? relDir.split('/').filter(Boolean) : [];
    const routeGroups: string[] = [];
    const urlSegments: string[] = [];

    for (const seg of rawSegments) {
      if (seg.startsWith('(') && seg.endsWith(')')) {
        routeGroups.push(seg);
      } else {
        urlSegments.push(seg);
      }
    }

    const routePath = '/' + urlSegments.join('/');
    const normalizedPath = routePath === '//' ? '/' : routePath || '/';

    let routeType: RouteType = 'page';
    let handlers: string[] | undefined;

    if (b.startsWith('+page.')) {
      routeType = 'page';
    } else if (b.startsWith('+layout.')) {
      routeType = 'layout';
    } else if (b.startsWith('+server.')) {
      routeType = 'api';
      handlers = await extractApiHandlers(file);
    }

    const layouts = routeType === 'page' ? getLayoutChain(fileDir) : undefined;

    routes.push({
      path: normalizedPath,
      filePath: normalize(file),
      type: routeType,
      framework: 'sveltekit',
      params: extractRouteParams(normalizedPath),
      ...(handlers ? { handlers } : {}),
      ...(layouts && layouts.length > 0 ? { layouts } : {}),
      ...(routeGroups.length > 0 ? { routeGroups } : {}),
    });
  }

  return routes;
}

/**
 * Scans an Inertia.js Pages directory and builds its route manifest.
 */
export async function scanInertiaPages(baseDir: string): Promise<RouteInfo[]> {
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
      const content = await readSourceFile(file);
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
