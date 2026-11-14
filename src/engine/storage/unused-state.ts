import { readSourceFile } from '../source-file';
import { basename, extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { collectFiles } from '../collector';
import type { UnusedStateItem, UnusedStateResult } from '../../types';
import { prepareStateQuery } from './state-query';

/**
 * Discovers dead or unreferenced state, composables, and stores across the workspace.
 */
export async function findUnusedState(
  workspaceRoot: string,
  options?: { scopePath?: string; excludeDirs?: string[]; skipSync?: boolean }
): Promise<UnusedStateResult> {
  const startTime = performance.now();
  const absRoot = resolve(workspaceRoot);
  // Scope limits findings; refresh outside consumers before declaring scoped state unused.
  const { db, sync } = await prepareStateQuery(absRoot, options?.skipSync);

  // 1. Identify all state candidate files in the workspace or scoped sub-path
  const scanTarget = options?.scopePath ? resolve(absRoot, options.scopePath) : absRoot;
  const allFiles = await collectFiles(absRoot, { excludeDirs: options?.excludeDirs });
  const stateCandidates = allFiles.filter((f) => {
    const scopedPath = relative(scanTarget, f);
    if (scopedPath === '..' || scopedPath.startsWith('../') || scopedPath.startsWith('..\\') || isAbsolute(scopedPath)) return false;
    const norm = f.replace(/\\/g, '/').toLowerCase();
    const ext = extname(f).toLowerCase();
    if (!['.ts', '.js', '.vue', '.tsx', '.jsx'].includes(ext)) return false;
    if (
      norm.includes('/node_modules/') ||
      norm.includes('/vendor/') ||
      norm.includes('/dist/') ||
      norm.includes('/.strata/')
    ) {
      return false;
    }
    return (
      norm.includes('/composables/') ||
      norm.includes('/hooks/') ||
      norm.includes('/stores/') ||
      norm.includes('/store/') ||
      norm.includes('/utils/state') ||
      norm.includes('/utils/composables') ||
      basename(norm).startsWith('use') ||
      basename(norm).endsWith('store.ts') ||
      basename(norm).endsWith('store.js')
    );
  });

  // 2. Extract declared identifiers (function names / store names) from each state candidate
  const declaredState: Array<{
    identifier: string;
    kind: 'store' | 'context' | 'composable';
    filePath: string;
  }> = [];

  for (const f of stateCandidates) {
    const norm = normalize(f);
    const base = basename(f, extname(f));
    try {
      const content = await readSourceFile(norm);
      const exportFuncMatches = content.matchAll(
        /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/g
      );
      const foundIdents = new Set<string>();
      for (const m of exportFuncMatches) {
        const ident = m[1];
        if (
          ident.startsWith('use') ||
          ident.endsWith('Store') ||
          ident.endsWith('Context') ||
          ident === base
        ) {
          foundIdents.add(ident);
        }
      }
      if (foundIdents.size === 0 && (base.startsWith('use') || base.endsWith('Store'))) {
        foundIdents.add(base);
      }

      for (const ident of foundIdents) {
        let kind: 'store' | 'context' | 'composable' = 'composable';
        if (ident.endsWith('Store') || norm.toLowerCase().includes('/stores/')) {
          kind = 'store';
        } else if (ident.endsWith('Context')) {
          kind = 'context';
        }

        declaredState.push({
          identifier: ident,
          kind,
          filePath: norm,
        });
      }
    } catch {
      // ignore
    }
  }

  // 3. For each declared state, check if any external consumer exists in SQLite state_deps
  const hasConsumerStmt = db.prepare(`
    SELECT 1
    FROM state_deps s
    JOIN files f ON s.file_id = f.id
    WHERE s.identifier = ? AND f.path != ?
    LIMIT 1;
  `);

  const unusedState: UnusedStateItem[] = [];

  for (const item of declaredState) {
    const hasConsumer = hasConsumerStmt.get(item.identifier, item.filePath);

    if (!hasConsumer) {
      unusedState.push({
        identifier: item.identifier,
        kind: item.kind,
        filePath: item.filePath,
      });
    }
  }

  // Deduplicate by filePath + identifier
  const uniqueUnused = Array.from(
    new Map(unusedState.map((u) => [`${u.filePath}::${u.identifier}`, u])).values()
  );

  const durationMs = Math.round(performance.now() - startTime);

  return {
    workspaceRoot: absRoot,
    totalScanned: declaredState.length,
    unusedCount: uniqueUnused.length,
    unusedState: uniqueUnused,
    _meta: {
      engine: 'sqlite-graph-cache',
      durationMs,
      cached: sync.cacheHit,
      syncGeneration: sync.syncGeneration,
      configFingerprint: sync.configFingerprint,
    },
  };
}
