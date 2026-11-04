import { readSourceFile } from './source-file';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import { extractRenderedCustomTags } from './tree';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import type { TemplateSimilarityCluster, TemplateSimilarityResult } from '../types';

interface TemplateFingerprint {
  filePath: string;
  relPath: string;
  tags: string[];
  tagSet: Set<string>;
  hasVFor: boolean;
  hasVModel: boolean;
  hasDrawer: boolean;
  hasModal: boolean;
}

/**
 * Extracts structural template tags, components, and layout directives from a component file.
 */
function extractFingerprint(filePath: string, content: string, rootDir: string): TemplateFingerprint | null {
  // Extract template block if SFC
  let templateContent = content;
  if (filePath.endsWith('.vue')) {
    try {
      const sfc = parseSfc(content, filePath);
      if (!sfc.template) return null;
      templateContent = sfc.template.content;
    } catch {
      const templateMatch = content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
      if (templateMatch) {
        templateContent = templateMatch[1];
      } else {
        return null;
      }
    }
  } else if (filePath.endsWith('.astro')) {
    try {
      const astro = parseAstro(content, filePath);
      if (!astro.template) return null;
      templateContent = astro.template.content;
    } catch {
      return null;
    }
  } else if (!filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) {
    // Non-template file without template block
    return null;
  }

  const tags = extractRenderedCustomTags(templateContent);
  if (tags.length === 0) return null;

  return {
    filePath,
    relPath: relative(rootDir, filePath).replace(/\\/g, '/'),
    tags,
    tagSet: new Set(tags),
    hasVFor: /\bv-for\b/.test(templateContent),
    hasVModel: /\bv-model\b/.test(templateContent),
    hasDrawer: /drawer/i.test(templateContent),
    hasModal: /modal|dialog/i.test(templateContent),
  };
}

/**
 * Computes structural similarity score (0.0 - 1.0) between two template fingerprints.
 */
function computeSimilarity(a: TemplateFingerprint, b: TemplateFingerprint): number {
  if (a.tagSet.size === 0 || b.tagSet.size === 0) return 0;

  // Jaccard similarity on custom component tags
  let intersectionCount = 0;
  for (const t of a.tagSet) {
    if (b.tagSet.has(t)) intersectionCount++;
  }
  const unionCount = new Set([...a.tagSet, ...b.tagSet]).size;
  const jaccard = unionCount > 0 ? intersectionCount / unionCount : 0;

  // Feature match bonus
  let featureMatches = 0;
  let featureTotal = 4;
  if (a.hasVFor === b.hasVFor) featureMatches++;
  if (a.hasVModel === b.hasVModel) featureMatches++;
  if (a.hasDrawer === b.hasDrawer) featureMatches++;
  if (a.hasModal === b.hasModal) featureMatches++;
  const featureScore = featureMatches / featureTotal;

  return Math.round((0.75 * jaccard + 0.25 * featureScore) * 100) / 100;
}

export interface FindSimilarTemplatesOptions {
  targetPath: string;
  scopePath?: string;
  threshold?: number;
  excludeDirs?: string[];
  workspaceRoot?: string;
}

/**
 * Discovers structural template duplication and DRY abstraction opportunities.
 * Supports directory-wide clustering (O(N²)) or 1-to-N lookup from a single component file (O(N)).
 */
export async function findSimilarTemplates(
  options: FindSimilarTemplatesOptions
): Promise<TemplateSimilarityResult> {
  const startTime = performance.now();
  const resolvedTarget = resolve(options.targetPath);
  const threshold = options.threshold !== undefined ? options.threshold : 0.8;

  // Single component file 1-to-N mode
  const isFileTarget = existsSync(resolvedTarget) && !(await fs.stat(resolvedTarget)).isDirectory();
  if (isFileTarget) {
    const targetFile = resolvedTarget;
    const targetExt = extname(targetFile).toLowerCase();
    const searchRoot = options.scopePath
      ? resolve(options.scopePath)
      : options.workspaceRoot
        ? resolve(options.workspaceRoot)
        : dirname(targetFile);

    let targetFp: TemplateFingerprint | null = null;
    try {
      const content = await readSourceFile(targetFile);
      targetFp = extractFingerprint(targetFile, content, searchRoot);
    } catch {
      // unreadable
    }

    if (!targetFp || targetFp.tags.length < 2) {
      return {
        workspaceRoot: searchRoot,
        clusters: [],
        totalComponentsAudited: 1,
      };
    }

    const allFiles = await collectFiles(searchRoot, {
      excludeDirs: options.excludeDirs,
    });

    const otherCandidates = allFiles.filter((f) => {
      if (resolve(f) === targetFile) return false;
      const ext = extname(f).toLowerCase();
      return ['.vue', '.astro', '.tsx', '.jsx'].includes(ext);
    });

    const matchedFingerprints: TemplateFingerprint[] = [];
    let totalSim = 0;

    for (const f of otherCandidates) {
      try {
        const content = await readSourceFile(f);
        const fp = extractFingerprint(f, content, searchRoot);
        if (fp && fp.tags.length >= 2) {
          const sim = computeSimilarity(targetFp, fp);
          if (sim >= threshold) {
            matchedFingerprints.push(fp);
            totalSim += sim;
          }
        }
      } catch {
        // ignore unreadable
      }
    }

    const clusters: TemplateSimilarityCluster[] = [];
    if (matchedFingerprints.length > 0) {
      const group = [targetFp, ...matchedFingerprints];
      const avgSim = Math.round((totalSim / matchedFingerprints.length) * 100) / 100;

      const sharedTags = Array.from(targetFp.tagSet).filter((t) =>
        group.every((g) => g.tagSet.has(t))
      );

      const sharedStructure: string[] = [];
      if (sharedTags.length > 0) {
        sharedStructure.push(`Components: <${sharedTags.join('>, <')}>`);
      }
      if (group.every((g) => g.hasVFor)) {
        sharedStructure.push('Pattern: v-for data iteration / swipeable card list');
      }
      if (group.every((g) => g.hasDrawer || g.hasModal)) {
        sharedStructure.push('Actions: drawer/modal filter and action sheet triggers');
      }

      const extCounts = new Map<string, number>();
      for (const g of group) {
        const ext = extname(g.filePath).toLowerCase();
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
      let dominantExt = targetExt;
      let maxCount = 0;
      for (const [ext, count] of extCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          dominantExt = ext;
        }
      }

      const baseName = basename(targetFile, extname(targetFile));
      const recommendation = `Candidate for shared generic component, e.g. <${baseName}Shared${dominantExt}> (${Math.round(avgSim * 100)}% structural match)`;

      clusters.push({
        similarity: avgSim,
        files: group.map((g) => g.filePath),
        sharedStructure,
        recommendation,
      });
    }

    return {
      workspaceRoot: searchRoot,
      clusters,
      totalComponentsAudited: otherCandidates.length + 1,
    };
  }

  const rootDir = resolvedTarget;
  const absScope = options.scopePath ? resolve(rootDir, options.scopePath) : undefined;

  const allFiles = await collectFiles(rootDir, {
    excludeDirs: options.excludeDirs,
  });

  const candidates = allFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    if (!['.vue', '.astro', '.tsx', '.jsx'].includes(ext)) return false;
    if (absScope) {
      const rel = relative(absScope, f);
      if (rel.startsWith('..') || isAbsolute(rel)) return false;
    }
    return true;
  });

  // Calculate project-wide dominant component extension to avoid biased fallback
  const projectExtCounts = new Map<string, number>();
  for (const f of candidates) {
    const ext = extname(f).toLowerCase();
    projectExtCounts.set(ext, (projectExtCounts.get(ext) || 0) + 1);
  }
  let projectDominantExt = '.vue';
  let maxProjCount = 0;
  for (const [ext, count] of projectExtCounts.entries()) {
    if (count > maxProjCount) {
      maxProjCount = count;
      projectDominantExt = ext;
    }
  }

  const fingerprints: TemplateFingerprint[] = [];
  for (const f of candidates) {
    try {
      const content = await readSourceFile(f);
      const fp = extractFingerprint(f, content, rootDir);
      if (fp && fp.tags.length >= 2) {
        fingerprints.push(fp);
      }
    } catch {
      // ignore unreadable files
    }
  }

  // Cluster similar files
  const clusters: TemplateSimilarityCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < fingerprints.length; i++) {
    const current = fingerprints[i];
    if (assigned.has(current.filePath)) continue;

    const group: TemplateFingerprint[] = [current];
    let totalSim = 0;
    let comparisons = 0;

    for (let j = i + 1; j < fingerprints.length; j++) {
      const other = fingerprints[j];
      if (assigned.has(other.filePath)) continue;

      const sim = computeSimilarity(current, other);
      if (sim >= threshold) {
        group.push(other);
        totalSim += sim;
        comparisons++;
      }
    }

    if (group.length >= 2) {
      group.forEach((g) => assigned.add(g.filePath));
      const avgSim = comparisons > 0 ? Math.round((totalSim / comparisons) * 100) / 100 : threshold;

      // Find shared components across all members in the cluster
      const sharedTags = Array.from(current.tagSet).filter((t) =>
        group.every((g) => g.tagSet.has(t))
      );

      const sharedStructure: string[] = [];
      if (sharedTags.length > 0) {
        sharedStructure.push(`Components: <${sharedTags.join('>, <')}>`);
      }
      if (group.every((g) => g.hasVFor)) {
        sharedStructure.push('Pattern: v-for data iteration / swipeable card list');
      }
      if (group.every((g) => g.hasDrawer || g.hasModal)) {
        sharedStructure.push('Actions: drawer/modal filter and action sheet triggers');
      }

      // Determine dominant component extension in the cluster (.tsx, .jsx, .astro, .vue)
      const extCounts = new Map<string, number>();
      for (const g of group) {
        const ext = extname(g.filePath).toLowerCase();
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
      let dominantExt = projectDominantExt;
      let maxCount = 0;
      for (const [ext, count] of extCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          dominantExt = ext;
        }
      }
      if (!['.tsx', '.jsx', '.astro', '.vue'].includes(dominantExt)) {
        dominantExt = projectDominantExt;
      }

      // Generate recommendation
      const commonSuffix = group
        .map((g) => basename(g.filePath, extname(g.filePath)))
        .reduce((common, name) => {
          while (!name.endsWith(common) && common.length > 3) {
            common = common.slice(1);
          }
          return common;
        });

      let recName = `BaseSharedView${dominantExt}`;
      if (commonSuffix && commonSuffix.length > 3) {
        const formattedSuffix = commonSuffix.charAt(0).toUpperCase() + commonSuffix.slice(1);
        recName = `Base${formattedSuffix}${dominantExt}`;
      }

      clusters.push({
        similarity: avgSim,
        files: group.map((g) => g.relPath),
        sharedStructure,
        recommendation: `Extract shared layout and card patterns to reusable: ${recName}`,
      });
    }
  }

  // Sort clusters by file count descending
  clusters.sort((a, b) => b.files.length - a.files.length);

  return {
    workspaceRoot: rootDir,
    clusters,
    totalComponentsAudited: fingerprints.length,
    _meta: {
      engine: 'template-similarity-comparator',
      durationMs: Math.round(performance.now() - startTime),
      cached: false,
    },
  };
}

/**
 * Formats TemplateSimilarityResult into human-readable, token-efficient text.
 */
export function formatSimilarTemplatesAsText(result: TemplateSimilarityResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Template Similarity & Abstraction Opportunities${metaBadge}`,
    `Audited Components: ${result.totalComponentsAudited}`,
    `Redundant / Reusable Clusters Found: ${result.clusters.length}`,
  ];

  if (result.clusters.length === 0) {
    lines.push('');
    lines.push('Result: No duplicate template patterns found exceeding the similarity threshold.');
    return lines.join('\n');
  }

  for (let idx = 0; idx < result.clusters.length; idx++) {
    const c = result.clusters[idx];
    const pct = Math.round(c.similarity * 100);
    lines.push('');
    lines.push(`Cluster ${idx + 1}: High Structural Overlap Found (${pct}% similarity) across ${c.files.length} components:`);
    for (const f of c.files.slice(0, 10)) {
      lines.push(`  - ${f}`);
    }
    if (c.files.length > 10) {
      lines.push(`  ... and ${c.files.length - 10} more components`);
    }

    if (c.sharedStructure.length > 0) {
      lines.push('');
      lines.push('  Shared Pattern:');
      for (const s of c.sharedStructure) {
        lines.push(`    • ${s}`);
      }
    }

    lines.push('');
    lines.push(`  Recommendation: ${c.recommendation}`);
  }

  return lines.join('\n');
}
