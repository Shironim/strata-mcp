import type { Database } from 'bun:sqlite';

interface ComponentSymbolRow {
  symbol_id: number;
  symbol_name: string;
  file_id: number;
  package_id: number;
  rel_path: string;
}

interface UnlinkedRenderEdgeRow {
  id: number;
  source_package_id: number;
  target_name: string;
}

interface TargetRef {
  fileId: number;
  symbolId: number;
  relPath: string;
}

/**
 * Converts a kebab-case / snake_case / dot-separated path segment into PascalCase.
 */
function toPascalCase(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Normalizes a component directory subpath into Nuxt's auto-imported PascalCase name,
 * deduplicating adjacent or prefix-overlapping segments (e.g. `home/HomeLogoCarousel` -> `HomeLogoCarousel`,
 * `home/LogoCarousel` -> `HomeLogoCarousel`, `ui/button/index` -> `UiButton`).
 */
function buildPrefixedComponentName(segments: string[]): string {
  const pascalParts = segments.map(toPascalCase).filter(Boolean);
  if (pascalParts.length === 0) return '';

  const deduped: string[] = [];
  for (let i = 0; i < pascalParts.length; i++) {
    const part = pascalParts[i]!;
    const next = pascalParts[i + 1];
    // Nuxt strips a directory segment if the next segment already starts with it (case-insensitive)
    if (next && next.toLowerCase().startsWith(part.toLowerCase())) {
      continue;
    }
    deduped.push(part);
  }
  return deduped.join('');
}

export interface DerivedComponentNames {
  /** Primary canonical name (Nuxt path-prefixed if inside `components/`, else symbolName). */
  primary: string;
  /** Secondary fallback aliases (e.g. unprefixed basename when pathPrefix is disabled). */
  fallbacks: string[];
}

/**
 * Derives auto-import component lookup names for a component symbol from its workspace-relative path.
 */
export function deriveComponentNames(relPath: string, symbolName: string): DerivedComponentNames {
  const norm = relPath.replace(/\\/g, '/');
  const match = norm.match(/(?:^|\/)components\/(.+)\.(?:vue|tsx|jsx|svelte|astro)$/i);
  if (!match) {
    return { primary: symbolName, fallbacks: [] };
  }

  const subPath = match[1]!;
  const rawSegments = subPath.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    return { primary: symbolName, fallbacks: [] };
  }

  const last = rawSegments[rawSegments.length - 1]!;
  const isIndexFile = last.toLowerCase() === 'index' && rawSegments.length > 1;
  const effectiveSegments = isIndexFile ? rawSegments.slice(0, -1) : rawSegments;

  const primary = buildPrefixedComponentName(effectiveSegments) || symbolName;
  const fallbackSet = new Set<string>();

  if (symbolName && symbolName !== primary && symbolName.toLowerCase() !== 'index') {
    fallbackSet.add(symbolName);
  }

  const leaf = toPascalCase(effectiveSegments[effectiveSegments.length - 1] ?? '');
  if (leaf && leaf !== primary) {
    fallbackSet.add(leaf);
  }

  return {
    primary,
    fallbacks: [...fallbackSet],
  };
}

/**
 * Strips Nuxt's `Lazy` component prefix (e.g. `LazyDocsL10nEditor` -> `DocsL10nEditor`).
 */
export function stripLazyComponentPrefix(name: string): string | null {
  if (name.length > 4 && name.startsWith('Lazy') && /^[A-Z]/.test(name.charAt(4))) {
    return name.slice(4);
  }
  return null;
}

function addTargetRef(map: Map<string, TargetRef[]>, key: string, ref: TargetRef): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [ref]);
    return;
  }
  if (!existing.some((item) => item.fileId === ref.fileId)) {
    existing.push(ref);
  }
}

/**
 * Picks a deterministic target when resolving an auto-imported component name:
 * - Unambiguous single match wins immediately.
 * - If multiple exist due to Nuxt layers (`layers/...` vs app root), prefer non-layer app component.
 * - Otherwise treat as ambiguous (null) to avoid false-positive cross-file edges.
 */
function pickUnambiguousTarget(candidates: TargetRef[] | undefined): TargetRef | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const nonLayer = candidates.filter((c) => !c.relPath.replace(/\\/g, '/').startsWith('layers/'));
  if (nonLayer.length === 1) return nonLayer[0]!;

  return null;
}

export interface LinkWorkspaceEdgesOptions {
  scopedSourceFileIds?: readonly number[];
}

/**
 * Cross-file Graph Linker:
 * Resolves unlinked `renders` edges (`target_file_id IS NULL`) against indexed workspace component
 * symbols, supporting Nuxt/Vue global auto-imports, directory-prefixed names, layers, and `Lazy*` components.
 *
 * Must be executed inside an active SQLite write transaction after file/symbol upserts.
 */
export function linkWorkspaceEdges(
  db: Database,
  options?: LinkWorkspaceEdgesOptions
): { linkedRenders: number; linkedCalls: number } {
  const rawScopedIds = options?.scopedSourceFileIds
    ? [...new Set(options.scopedSourceFileIds.map((id) => Math.trunc(id)))]
    : null;
  if (rawScopedIds && rawScopedIds.length === 0) {
    return { linkedRenders: 0, linkedCalls: 0 };
  }
  // Guard against SQLITE_MAX_VARIABLE_NUMBER (999) when batching large dirty sets
  const scopedIds = rawScopedIds && rawScopedIds.length <= 500 ? rawScopedIds : null;

  const scopedClause = scopedIds
    ? ` AND e.source_file_id IN (${scopedIds.map(() => '?').join(',')})`
    : '';
  const scopedParams = scopedIds ?? [];

  const unlinkedEdges = db
    .query(
      `SELECT e.id, f.package_id AS source_package_id, e.target_name
       FROM symbol_edges e
       JOIN files f ON f.id = e.source_file_id
       WHERE e.edge_kind = 'renders'
         AND e.target_file_id IS NULL
         AND e.target_name IS NOT NULL${scopedClause}`
    )
    .all(...scopedParams) as UnlinkedRenderEdgeRow[];

  const unlinkedCalls = db
    .query(
      `SELECT e.id, f.package_id AS source_package_id, e.target_name
       FROM symbol_edges e
       JOIN files f ON f.id = e.source_file_id
       WHERE e.edge_kind = 'calls'
         AND e.target_file_id IS NULL
         AND e.target_name GLOB 'use[A-Z]*'${scopedClause}`
    )
    .all(...scopedParams) as UnlinkedRenderEdgeRow[];

  if (unlinkedEdges.length === 0 && unlinkedCalls.length === 0) {
    return { linkedRenders: 0, linkedCalls: 0 };
  }

  const getPkgMap = (outer: Map<number, Map<string, TargetRef[]>>, pkgId: number) => {
    let inner = outer.get(pkgId);
    if (!inner) {
      inner = new Map<string, TargetRef[]>();
      outer.set(pkgId, inner);
    }
    return inner;
  };

  const updateEdgeStmt = db.prepare(
    'UPDATE symbol_edges SET target_file_id = ?, target_symbol_id = ? WHERE id = ?'
  );

  let linkedRenders = 0;
  if (unlinkedEdges.length > 0) {
    const componentRows = db
      .query(
        `SELECT s.id AS symbol_id, s.name AS symbol_name, f.id AS file_id, f.package_id, f.rel_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.kind = 'component'`
      )
      .all() as ComponentSymbolRow[];

    if (componentRows.length > 0) {
      const pkgPrimary = new Map<number, Map<string, TargetRef[]>>();
      const pkgFallback = new Map<number, Map<string, TargetRef[]>>();
      const globalPrimary = new Map<string, TargetRef[]>();
      const globalFallback = new Map<string, TargetRef[]>();

      for (const row of componentRows) {
        const ref: TargetRef = {
          fileId: row.file_id,
          symbolId: row.symbol_id,
          relPath: row.rel_path,
        };
        const { primary, fallbacks } = deriveComponentNames(row.rel_path, row.symbol_name);

        addTargetRef(getPkgMap(pkgPrimary, row.package_id), primary, ref);
        addTargetRef(globalPrimary, primary, ref);

        for (const fb of fallbacks) {
          addTargetRef(getPkgMap(pkgFallback, row.package_id), fb, ref);
          addTargetRef(globalFallback, fb, ref);
        }
      }

      const resolveByName = (packageId: number, name: string): TargetRef | null => {
        return (
          pickUnambiguousTarget(pkgPrimary.get(packageId)?.get(name)) ??
          pickUnambiguousTarget(pkgFallback.get(packageId)?.get(name)) ??
          pickUnambiguousTarget(globalPrimary.get(name)) ??
          pickUnambiguousTarget(globalFallback.get(name))
        );
      };

      for (const edge of unlinkedEdges) {
        let target = resolveByName(edge.source_package_id, edge.target_name);
        if (!target) {
          const stripped = stripLazyComponentPrefix(edge.target_name);
          if (stripped) {
            target = resolveByName(edge.source_package_id, stripped);
          }
        }
        if (!target) continue;

        updateEdgeStmt.run(target.fileId, target.symbolId, edge.id);
        linkedRenders++;
      }
    }
  }

  // Also link auto-imported composable calls (`use*`) when target_file_id is NULL
  let linkedCalls = 0;
  if (unlinkedCalls.length > 0) {
    const composableRows = db
      .query(
        `SELECT s.id AS symbol_id, s.name AS symbol_name, f.id AS file_id, f.package_id, f.rel_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.name GLOB 'use[A-Z]*'
           AND s.kind != 'component'`
      )
      .all() as ComponentSymbolRow[];

    const pkgComposables = new Map<number, Map<string, TargetRef[]>>();
    const globalComposables = new Map<string, TargetRef[]>();
    for (const row of composableRows) {
      const ref: TargetRef = {
        fileId: row.file_id,
        symbolId: row.symbol_id,
        relPath: row.rel_path,
      };
      addTargetRef(getPkgMap(pkgComposables, row.package_id), row.symbol_name, ref);
      addTargetRef(globalComposables, row.symbol_name, ref);
    }

    for (const edge of unlinkedCalls) {
      const target =
        pickUnambiguousTarget(pkgComposables.get(edge.source_package_id)?.get(edge.target_name)) ??
        pickUnambiguousTarget(globalComposables.get(edge.target_name));
      if (!target) continue;
      updateEdgeStmt.run(target.fileId, target.symbolId, edge.id);
      linkedCalls++;
    }
  }

  return { linkedRenders, linkedCalls };
}
