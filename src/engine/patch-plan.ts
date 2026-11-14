import { readSourceSnapshot, sliceSourceSnapshot } from './source-file';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parseSfc } from './splitter';
import { extractImports } from './graph/path-helpers';
import { getComponentTree, resolveImportPath, resolveBarrelExport } from './tree';
import { loadAliasConfig } from './resolver';
import { findProjectRoot } from './path-resolver';
import { collectFiles } from './collector';
import { getCandidateNames } from './template';
import { STRATA_VERSION } from '../version';
import { collectVuePatchOmissions, collectJsxPatchOmissions } from './patch-coverage';
import { prepareIndexedAnalysis } from './prepare-index';
import {
  cleanIdentifier,
  matchVueProp,
  matchVueEvent,
  getCandidateTagNames,
  scanVueTemplateProps,
  scanTsxLikeProps,
} from './parsers/patch-scanners';
import type {
  ComponentPatchItem,
  PatchPlanOptions,
  PatchPlanResult,
  PatchRefactorType,
} from '../types';

export { cleanIdentifier, matchVueProp, matchVueEvent };

export function normalizePatchOperations(options: PatchPlanOptions) {
  const validRefactorTypes: PatchRefactorType[] = [
    'rename_prop', 'remove_prop', 'rename_event', 'remove_event',
    'rename_model', 'remove_model', 'rename_slot', 'remove_slot',
  ];

  const rawOps =
    options.operations && Array.isArray(options.operations) && options.operations.length > 0
      ? options.operations
      : [
          {
            refactorType: options.refactorType as PatchRefactorType,
            oldName: options.oldName as string,
            newName: options.newName,
          },
        ];

  return rawOps.map((op) => {
    if (!validRefactorTypes.includes(op.refactorType)) {
      throw Object.assign(
        new Error(`Invalid refactor_type. Supported operations: ${validRefactorTypes.join(', ')}.`),
        { code: 'INVALID_ARGUMENT' }
      );
    }
    const cleanOld = typeof op.oldName === 'string' ? cleanIdentifier(op.oldName.trim()) : '';
    const cleanNew = typeof op.newName === 'string' ? cleanIdentifier(op.newName.trim()) : undefined;
    if (!cleanOld) {
      throw Object.assign(new Error('"old_name" is required and must not be empty.'), { code: 'INVALID_ARGUMENT' });
    }
    if (op.refactorType.startsWith('rename_') && !cleanNew) {
      throw Object.assign(new Error(`"new_name" is required when refactor_type is "${op.refactorType}".`), { code: 'INVALID_ARGUMENT' });
    }
    return {
      refactorType: op.refactorType,
      oldName: op.oldName,
      newName: op.newName,
      cleanOld,
      cleanNew,
    };
  });

}

/**
 * Generates an automated, prescriptive AST patch plan across all upward consumers of a component.
 */
export async function generatePatchPlan(options: PatchPlanOptions): Promise<PatchPlanResult> {
  const { componentPath, targetPath } = options;
  const normalizedOps = normalizePatchOperations(options);

  const projectRoot = targetPath ? resolve(targetPath) : findProjectRoot(componentPath);
  const absComponentPath = resolve(componentPath);
  if (!options.skipSync) await prepareIndexedAnalysis(projectRoot, true);

  // Index component candidate names in project to detect collision for auto-imports
  const allProjectFiles = await collectFiles(projectRoot);
  const candidateToFileMap = new Map<string, string[]>();
  for (const file of allProjectFiles) {
    const ext = extname(file).toLowerCase();
    if (ext === '.vue' || ext === '.astro' || ext === '.svelte' || ext === '.tsx' || ext === '.jsx') {
      const base = basename(file, ext);
      for (const cand of getCandidateNames(base)) {
        const key = cand.toLowerCase();
        const list = candidateToFileMap.get(key) || [];
        if (!list.includes(resolve(file))) list.push(resolve(file));
        candidateToFileMap.set(key, list);
      }
    }
  }

  const compName = basename(absComponentPath, extname(absComponentPath));
  const targetTags = getCandidateTagNames(compName);

  // 1. Resolve upward tree to get all consumer components (blast radius)
  const treeResult = await getComponentTree({
    skipSync: true,
    entryPath: absComponentPath,
    direction: 'upward',
    targetPath: projectRoot,
    maxDepth: 1,
    limit: 1000,
  });

  const consumerFiles = new Set<string>();

  function collectConsumerPaths(node: typeof treeResult.root): void {
    const candidatePath = node.filePath || (node as any).path;
    if (candidatePath && resolve(candidatePath) !== absComponentPath) {
      consumerFiles.add(candidatePath);
    }
    node.children?.forEach(collectConsumerPaths);
  }

  collectConsumerPaths(treeResult.root);

  const allPatches: ComponentPatchItem[] = [];
  const coverage: PatchPlanResult['coverage'] = {
    candidateCount: consumerFiles.size, analyzedCount: 0, failedCount: 0,
    unsupportedCount: 0, analyzedWithPatchCount: 0, analyzedWithoutPatchCount: 0,
    discovery: 'graph-bounded', diagnostics: [], omissions: [],
    operationScope: { consumerUsages: 'supported-static-usages', targetDeclaration: 'not-included', forwarding: 'not-included', dynamicComponents: 'not-included' },
  };

  // Forward discovery exclusions to coverage accounting
  if (treeResult.diagnostics?.length) {
    for (const d of treeResult.diagnostics) {
      if (d.code === 'CONSUMER_SOURCE_READ_FAILED') {
        coverage.failedCount++;
        coverage.candidateCount++;
        coverage.diagnostics.push({ file: d.filePath, code: d.code, message: d.reason });
      } else if (d.code === 'CONSUMER_INPUT_UNSUPPORTED') {
        coverage.unsupportedCount++;
        coverage.candidateCount++;
        coverage.diagnostics.push({ file: d.filePath, code: d.code, message: d.reason });
      } else if (
        d.code === 'MAX_DEPTH_REACHED' ||
        d.code === 'SCOPE_BOUNDARY' ||
        d.code === 'CYCLE_TRUNCATED' ||
        d.code === 'UPWARD_RESULTS_TRUNCATED'
      ) {
        coverage.diagnostics.push({ file: d.filePath, code: d.code, message: d.reason });
      }
    }
  }

  // 2. For each consumer file, parse template / JSX and locate exact code replacements
  for (const consumerPath of [...consumerFiles].sort()) {
    const patchesBefore = allPatches.length;
    const omissionsBefore = coverage.omissions.length;
    if (!existsSync(consumerPath)) {
      coverage.failedCount++;
      coverage.diagnostics.push({ file: consumerPath, code: 'SOURCE_MISSING', message: 'Discovered consumer no longer exists.' });
      continue;
    }

    try {
      const { content, snapshot } = await readSourceSnapshot(consumerPath);
      const ext = extname(consumerPath).toLowerCase();
      if (!['.vue', '.astro', '.tsx', '.jsx', '.svelte'].includes(ext)) {
        coverage.unsupportedCount++;
        coverage.diagnostics.push({ file: consumerPath, code: 'UNSUPPORTED_CONSUMER', message: `Patch scanning is not supported for ${ext}.` });
        continue;
      }
      const aliasConfig = await loadAliasConfig(consumerPath);
      const consumerTags = new Set<string>();
      const boundToOther = new Set<string>();

      for (const imp of extractImports(content, consumerPath)) {
        const isLocal = imp.source.startsWith('.') || imp.source.startsWith('/') || aliasConfig?.isAlias(imp.source);
        let importedPath = isLocal ? resolveImportPath(consumerPath, imp.source, aliasConfig) : null;
        if (importedPath && /[/\\]index\.[tj]sx?$/.test(importedPath)) {
          importedPath = resolveBarrelExport(importedPath, imp.name, aliasConfig) ?? importedPath;
        }
        if (importedPath && resolve(importedPath) === absComponentPath) {
          const importName = imp.alias || imp.name;
          consumerTags.add(importName);
          for (const cand of getCandidateNames(importName)) {
            consumerTags.add(cand);
          }
        } else {
          const boundName = imp.alias || imp.name;
          if (boundName && boundName !== '*') {
            for (const cand of getCandidateNames(boundName)) {
              boundToOther.add(cand.toLowerCase());
            }
          }
        }
      }

      // Check auto-import for Vue and Astro only if not explicitly bound to another component
      if (ext !== '.tsx' && ext !== '.jsx') {
        for (const tag of targetTags) {
          if (!boundToOther.has(tag.toLowerCase())) {
            const matching = candidateToFileMap.get(tag.toLowerCase()) || [];
            if (matching.length === 1 && matching[0] === absComponentPath) consumerTags.add(tag);
          }
        }
      }

      if (consumerTags.size === 0) {
        coverage.omissions.push({ file: consumerPath, code: 'TARGET_BINDING_UNRESOLVED', resolution: 'candidate', message: 'Graph discovery identified this candidate, but no supported local binding to the target was resolved from the analyzed source.' });
      }

      const filePatches: ComponentPatchItem[] = [];

      if (ext === '.vue') {
        const sfc = parseSfc(content, consumerPath);
        if (sfc.diagnostics?.length) throw new Error(`PARSE_FAILED: ${sfc.diagnostics.map(d => d.message).join('; ')}`);
        if (sfc.template) {
          if (sfc.template.lang && sfc.template.lang !== 'html') {
            coverage.unsupportedCount++;
            coverage.diagnostics.push({ file: consumerPath, code: 'UNSUPPORTED_TEMPLATE_LANGUAGE', message: `Patch analysis does not support template language ${sfc.template.lang}.` });
            continue;
          }
          coverage.omissions.push(...collectVuePatchOmissions(sfc.template.content, sfc.template.loc.start.offset, consumerPath, snapshot.sha256, consumerTags));
          for (const op of normalizedOps) {
            const templatePatches = scanVueTemplateProps(
              sfc.template.content,
              sfc.template.loc.start.line,
              sfc.template.loc.start.column,
              consumerTags,
              op.refactorType,
              op.cleanOld,
              op.cleanNew,
              consumerPath
            );
            filePatches.push(...templatePatches);
          }
        }
      } else if (ext === '.astro') {
        coverage.omissions.push({ file: consumerPath, code: 'USAGE_COVERAGE_NOT_ENUMERATED', resolution: 'unsupported', message: 'Astro patches cover supported static usages; spread, forwarding and dynamic usages are not exhaustively inventoried.' });
        for (const op of normalizedOps) {
          filePatches.push(...scanTsxLikeProps(content, consumerTags, op.refactorType, op.cleanOld, op.cleanNew, consumerPath, {
            kindLabel: 'Astro attribute',
            preserveKebabCase: true,
            maskAstroFrontmatter: true,
          }));
        }
      } else if (ext === '.tsx' || ext === '.jsx') {
        coverage.omissions.push(...collectJsxPatchOmissions(content, consumerPath, snapshot.sha256, consumerTags));
        for (const op of normalizedOps) {
          filePatches.push(...scanTsxLikeProps(content, consumerTags, op.refactorType, op.cleanOld, op.cleanNew, consumerPath, {
            kindLabel: 'JSX attribute',
            preserveKebabCase: false,
          }));
        }
      } else if (ext === '.svelte') {
        coverage.omissions.push(...collectJsxPatchOmissions(content, consumerPath, snapshot.sha256, consumerTags));
        for (const op of normalizedOps) {
          filePatches.push(...scanTsxLikeProps(content, consumerTags, op.refactorType, op.cleanOld, op.cleanNew, consumerPath, {
            kindLabel: 'Svelte prop',
            preserveKebabCase: true,
          }));
        }
      }

      const lines = content.split('\n');
      for (const patch of filePatches) {
        if (patch.line < 1 || patch.line > lines.length || patch.column < 1) throw new Error('INVALID_PATCH_SPAN: invalid source coordinates');
        const startOffset = lines.slice(0, patch.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + patch.column - 1;
        const ref = { sha256: snapshot.sha256, startOffset, endOffset: startOffset + patch.oldSnippet.length };
        if (sliceSourceSnapshot(snapshot, content, ref) !== patch.oldSnippet) throw new Error('INVALID_PATCH_SPAN: snippet does not match source coordinates');
        patch.sourceRef = ref;
      }

      // Sort patches by startOffset
      filePatches.sort((a, b) => (a.sourceRef?.startOffset ?? 0) - (b.sourceRef?.startOffset ?? 0));

      // Filter overlapping patch spans to avoid corrupted byte offsets
      const nonColliding: ComponentPatchItem[] = [];
      for (const patch of filePatches) {
        if (nonColliding.length > 0) {
          const prev = nonColliding[nonColliding.length - 1];
          if (prev.sourceRef && patch.sourceRef && patch.sourceRef.startOffset < prev.sourceRef.endOffset) {
            coverage.omissions.push({
              file: consumerPath,
              code: 'PATCH_SPAN_COLLISION',
              resolution: 'unsupported',
              message: `Patch for ${patch.targetTag} (${patch.oldSnippet}) collides with overlapping patch span (${prev.oldSnippet}).`,
              sourceRef: patch.sourceRef,
            });
            continue;
          }
        }
        nonColliding.push(patch);
      }
      allPatches.push(...nonColliding);

      coverage.analyzedCount++;
      if (allPatches.length > patchesBefore) coverage.analyzedWithPatchCount++;
      else coverage.analyzedWithoutPatchCount++;
    } catch (error) {
      allPatches.length = patchesBefore;
      coverage.omissions.length = omissionsBefore;
      coverage.failedCount++;
      coverage.diagnostics.push({ file: consumerPath, code: 'CONSUMER_ANALYSIS_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Mathematically enforce the invariant candidateCount = analyzedCount + failedCount + unsupportedCount
  coverage.candidateCount = coverage.analyzedCount + coverage.failedCount + coverage.unsupportedCount;

  return {
    component: absComponentPath,
    refactorType: normalizedOps[0].refactorType,
    oldName: normalizedOps[0].cleanOld,
    newName: normalizedOps[0].cleanNew,
    operations: options.operations,
    totalConsumersAudited: coverage.analyzedCount,
    coverage,
    totalPatches: allPatches.length,
    patches: allPatches,
    _meta: {
      framework: 'multi-framework',
      version: STRATA_VERSION,
    },
  };
}
