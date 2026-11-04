import { readSourceFile } from './source-file';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { unwrapExpression, staticPropertyName } from './parsers/ts-syntax';
import { parseSfc } from './splitter';
import { collectFiles } from './collector';
import { deriveNextEffectiveConfig } from './next-effective-config';
import { resolveProjectOwnership } from './project-ownership';
import type {
  NextSegmentConfigContract,
  NuxtPageMetaContract,
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
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
    sourceFile = ts.createSourceFile('segment-config.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

  const validExts = ['.tsx', '.jsx', '.js', '.ts'];

  for (const file of files) {
    const b = basename(file);
    const ext = extname(file);
    if (!validExts.includes(ext)) continue;

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

    // Determine convention type
    let routeType: RouteType | undefined;
    if (b.startsWith('page.')) {
      routeType = 'page';
    } else if (b.startsWith('route.') && ['.ts', '.js'].includes(ext)) {
      routeType = 'api';
    } else if (b.startsWith('layout.')) {
      routeType = 'layout';
    } else if (b.startsWith('loading.')) {
      routeType = 'loading';
    } else if (b.startsWith('error.') || b.startsWith('global-error.')) {
      routeType = 'error';
    } else if (b.startsWith('not-found.')) {
      routeType = 'not-found';
    } else if (b.startsWith('template.')) {
      routeType = 'template';
    } else if (b.startsWith('default.')) {
      routeType = 'default';
    }

    if (!routeType) continue;

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

/**
 * Extracts definePageMeta configuration from a Nuxt page file via TypeScript AST.
 */
export function extractNuxtPageMeta(content: string): NuxtPageMetaContract | undefined {
  if (!content.includes('definePageMeta')) return undefined;
  const script = content.includes('<script') ? parseSfc(content).scriptSetup?.content : content;
  if (!script) return undefined;
  const sf = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
async function scanNuxtPages(baseDir: string, projectRoot: string): Promise<RouteInfo[]> {
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
 * Scans a SvelteKit routes directory (+page.svelte, +layout.svelte, +server.ts) and builds its route manifest.
 */
async function scanSvelteKitRoutes(baseDir: string): Promise<RouteInfo[]> {
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

/**
 * Scans a Vue Router configuration file (e.g. src/router/index.ts) using TypeScript AST.
 */
async function scanVueRouterFromConfig(routerConfigFile: string): Promise<RouteInfo[] | null> {
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
async function scanVueRouterPages(baseDir: string, projectRoot?: string): Promise<RouteInfo[]> {
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
  const effectiveScanTarget = targetPath;
  const projectContext = resolveProjectOwnership(join(targetPath, '__strata_route_probe__.ts'));
  const detection = await detectRouteFramework(effectiveScanTarget);
  const framework = options.frameworkHint || detection.framework;
  let baseDir = detection.baseDir;

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
  if (result.projectContext) {
    lines.push(`Project owner: ${result.projectContext.ownerRoot ?? 'unverified'} (${result.projectContext.status})`);
    for (const issue of result.projectContext.diagnostics) lines.push(`Ownership partial (${issue.code}): ${issue.reason}`);
  }

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
    if (r.nextEffectiveSegmentConfig) {
      const effective = r.nextEffectiveSegmentConfig;
      lines.push(`    Observed segment config: ${JSON.stringify(effective.config)} (freshness: ${effective.freshness}; runtime behavior unverified)`);
      for (const issue of effective.unresolvedFields) lines.push(`    Partial ${issue.field}: ${issue.reason}`);
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
