import { TOOL_CATALOG } from './catalog';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { getComponentTree, formatTreeAsText } from '../engine/tree';
import {
  findProjectRoot,
  parseAliasMapInput,
  parseSafePositiveInt,
  resolveProjectRoot,
  resolveWorkspacePath,
} from '../engine/path-resolver';
import type { ComponentTreeNode, ComponentTreeOptions } from '../types';
import type { McpToolDefinition } from './types';

export const componentTreeTool: McpToolDefinition = {
  ...TOOL_CATALOG[2],
  handler: async (args: Record<string, any>) => {
    const routePath = (args.route || args.route_path) ? String(args.route || args.route_path) : undefined;

    let rawEntryPath = (args.entry_path || args.entryPath || args.file_path || args.filePath || args.component || args.component_path)
      ? String(args.entry_path || args.entryPath || args.file_path || args.filePath || args.component || args.component_path)
      : undefined;

    let rawTargetPath = (args.target_path || args.targetPath) ? String(args.target_path || args.targetPath) : undefined;

    if (rawTargetPath && /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(rawTargetPath)) {
      if (!rawEntryPath) rawEntryPath = rawTargetPath;
      rawTargetPath = undefined;
    }

    // Disambiguate generic `path`: is it an entry component file or project root?
    if (args.path) {
      const candidate = String(args.path);
      const isFileLike = /\.(vue|tsx|jsx|svelte|astro|ts|js)$/i.test(candidate);
      let isActualFile = false;
      try {
        const fullCandidate = resolveWorkspacePath(candidate);
        if (fs.existsSync(fullCandidate) && fs.statSync(fullCandidate).isFile()) {
          isActualFile = true;
        }
      } catch {}

      if (isFileLike || isActualFile) {
        if (!rawEntryPath) rawEntryPath = candidate;
      } else if (!rawTargetPath) {
        rawTargetPath = candidate;
      }
    }

    const resolvedTargetPath = rawTargetPath
      ? resolve(rawTargetPath)
      : rawEntryPath ? findProjectRoot(resolveWorkspacePath(rawEntryPath)) : resolveProjectRoot();
    const entryPath = rawEntryPath ? resolveWorkspacePath(rawEntryPath, resolvedTargetPath) : undefined;
    const targetPath = resolvedTargetPath;

    if (!entryPath && !routePath) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: "Missing required argument: provide 'entry_path' (file path) or 'route' (URL route path).",
          },
        ],
      };
    }

    try {
      const maxDepth = parseSafePositiveInt(args.max_depth ?? args.maxDepth ?? args.depth);

      const rawDir = String(args.direction || '').toLowerCase();
      const direction: ComponentTreeOptions['direction'] =
        rawDir === 'upward' || rawDir === 'up'
          ? 'upward'
          : rawDir === 'downward' || rawDir === 'down'
            ? 'downward'
            : undefined;

      const rawScopeFilter = args.scope_filter ?? args.scope_path ?? args.scopeFilter ?? args.scopePath;
      const scopeFilter = rawScopeFilter ? String(rawScopeFilter) : undefined;
      const aliasMap = parseAliasMapInput(args.alias_map ?? args.aliasMap ?? args.alias);

      const { isWorkspaceIndexed } = await import('../engine/storage/schema');
      if (!isWorkspaceIndexed(targetPath)) {
        const isJson = args.output_format === 'json' || args.format === 'json';
        const notIndexedPayload = {
          status: 'NOT_INDEXED',
          message: "Workspace belum diindeks oleh Strata. Jalankan 'strata init' terlebih dahulu di terminal atau panggil tool inisialisasi yang disetujui.",
        };
        return {
          content: [
            {
              type: 'text',
              text: isJson
                ? JSON.stringify(notIndexedPayload, null, 2)
                : `[strata NOT_INDEXED] ${notIndexedPayload.message}`,
            },
          ],
        };
      }

      // Freshness preflight: ensure cached SQLite graph matches current disk state
      const { syncWorkspace } = await import('../engine/storage/delta-sync');
      await syncWorkspace(targetPath);

      const tree = await getComponentTree({
        entryPath,
        routePath,
        targetPath,
        maxDepth,
        direction,
        aliasMap,
        scopeFilter,
      });

      if (args.include_props === false || args.includeProps === false) {
        const stripProps = (n: ComponentTreeNode) => {
          delete (n as { passedProps?: unknown }).passedProps;
          n.children?.forEach(stripProps);
        };
        stripProps(tree.root);
      }

      const isJson = args.output_format === 'json' || args.format === 'json';
      return {
        content: [
          {
            type: 'text',
            text: isJson ? JSON.stringify(tree, null, 2) : formatTreeAsText(tree),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to resolve component tree: ${msg}` }],
      };
    }
  },
};
