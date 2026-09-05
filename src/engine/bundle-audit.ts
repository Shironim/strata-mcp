import { promises as fs } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import type { BundleAuditResult, BundleWeightWarning } from '../types';

interface HeavyModuleCatalogItem {
  name: string;
  category: BundleWeightWarning['category'];
  defaultRecommendation: string;
}

const HEAVY_MODULES: HeavyModuleCatalogItem[] = [
  // Charts
  { name: 'echarts', category: 'chart', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: 'chart.js', category: 'chart', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: 'recharts', category: 'chart', defaultRecommendation: 'Gunakan dynamic import via React.lazy() atau next/dynamic' },
  { name: 'apexcharts', category: 'chart', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: 'd3', category: 'chart', defaultRecommendation: 'Gunakan sub-path import terfokus (misal: d3-scale) atau dynamic import' },
  // Rich Text / Editors
  { name: 'quill', category: 'rich-text', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: 'tinymce', category: 'rich-text', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: 'monaco-editor', category: 'rich-text', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau monaco lazy loader' },
  { name: '@tiptap/core', category: 'rich-text', defaultRecommendation: 'Gunakan dynamic import untuk Rich Text editor' },
  // PDF / Spreadsheet
  { name: 'pdfjs-dist', category: 'pdf', defaultRecommendation: 'Gunakan dynamic import via import("pdfjs-dist") saat user meminta view/render' },
  { name: 'jspdf', category: 'pdf', defaultRecommendation: 'Gunakan dynamic import saat fungsi export PDF dieksekusi' },
  { name: 'xlsx', category: 'spreadsheet', defaultRecommendation: 'Gunakan dynamic import saat export/import spreadsheet' },
  // 3D / Canvas
  { name: 'three', category: '3d-canvas', defaultRecommendation: 'Gunakan dynamic import via defineAsyncComponent() atau React.lazy()' },
  { name: '@react-three/fiber', category: '3d-canvas', defaultRecommendation: 'Gunakan dynamic import (next/dynamic atau React.lazy)' },
  { name: 'konva', category: '3d-canvas', defaultRecommendation: 'Gunakan dynamic import untuk modul canvas rendering' },
  // Heavy Utilities
  { name: 'moment', category: 'heavy-utility', defaultRecommendation: 'Pertimbangkan migrasi ke dayjs atau date-fns yang tree-shakeable' },
];

const COMPONENT_EXTENSIONS = new Set(['.vue', '.tsx', '.jsx', '.astro', '.ts', '.js']);

export interface AuditBundleOptions {
  targetPath: string;
  scopePath?: string;
  excludeDirs?: string[];
}

/**
 * Audits frontend codebase for synchronous heavy module imports and eager Astro island hydration (Zero-Bloat Bundle).
 */
export async function auditBundleHealth(options: AuditBundleOptions): Promise<BundleAuditResult> {
  const startTime = performance.now();
  const rootDir = resolve(options.targetPath);
  const allFiles = await collectFiles(rootDir, { excludeDirs: options.excludeDirs });

  const heavyEagerImports: BundleWeightWarning[] = [];
  let totalFilesAudited = 0;

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!COMPONENT_EXTENSIONS.has(ext)) continue;

    // Exclude test files, configs, and node_modules
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('vite.config') || file.includes('tailwind.config')) {
      continue;
    }

    if (options.scopePath && !file.includes(options.scopePath)) {
      continue;
    }

    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    totalFilesAudited++;
    const relPath = relative(rootDir, file).replace(/\\/g, '/');

    // 1. Check for synchronous eager imports of heavy modules
    for (const mod of HEAVY_MODULES) {
      // Regex for static import statement: import ... from 'mod' or import 'mod'
      const importRegex = new RegExp(`^\\s*import\\s+(?:(?:[A-Za-z0-9_$*\\s{},]+)\\s+from\\s+)?['"]${mod.name}(?:\\/[^'"]*)?['"]`, 'gm');
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const offset = match.index;
        const line = content.substring(0, offset).split('\n').length;

        // Check framework context for recommendation
        let recommendation = mod.defaultRecommendation;
        if (ext === '.vue') {
          recommendation = `Modul berat "${mod.name}" diimpor secara sinkron. Gunakan defineAsyncComponent(() => import('${mod.name}')) untuk code-splitting.`;
        } else if (ext === '.tsx' || ext === '.jsx') {
          recommendation = `Modul berat "${mod.name}" diimpor secara sinkron. Gunakan React.lazy(() => import('${mod.name}')) atau next/dynamic untuk code-splitting.`;
        }

        heavyEagerImports.push({
          file: relPath,
          line,
          module: mod.name,
          category: mod.category,
          recommendation,
        });
      }
    }

    // 2. In Astro files, audit eager client:load hydration on heavy Islands
    if (ext === '.astro') {
      const clientLoadRegex = /<([A-Z][A-Za-z0-9_$]*)\b[^>]*?\b(client:load)\b[^>]*\/?>/g;
      let astroMatch: RegExpExecArray | null;

      while ((astroMatch = clientLoadRegex.exec(content)) !== null) {
        const compName = astroMatch[1];
        const offset = astroMatch.index;
        const line = content.substring(0, offset).split('\n').length;

        heavyEagerImports.push({
          file: relPath,
          line,
          module: compName,
          category: 'heavy-utility',
          islandDirective: 'client:load',
          recommendation: `Island component <${compName} client:load /> di-hydrate segera saat halaman dibuka. Pertimbangkan beralih ke client:visible atau client:idle untuk memangkas TBT/LCP.`,
        });
      }
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    workspaceRoot: rootDir,
    totalFilesAudited,
    heavyEagerImports,
    totalWarnings: heavyEagerImports.length,
    _meta: {
      engine: 'in-memory-ast',
      durationMs,
    },
  };
}

/**
 * Formats BundleAuditResult into token-efficient, human-readable text.
 */
export function formatBundleAuditAsText(result: BundleAuditResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Zero-Bloat Bundle & Island Architecture Audit${metaBadge}`,
    `Total Files Scanned: ${result.totalFilesAudited}`,
    `Total Warnings: ${result.totalWarnings}`,
  ];

  if (result.totalWarnings === 0) {
    lines.push('');
    lines.push('Result: No heavy synchronous imports or eager island hydration warnings detected.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Heavy Synchronous Imports & Island Hydration Warnings:');
  for (const w of result.heavyEagerImports) {
    const directiveTag = w.islandDirective ? ` [Directive: ${w.islandDirective}]` : ` [Category: ${w.category}]`;
    lines.push(`  ⚠️  ${w.file}:${w.line} — Module: "${w.module}"${directiveTag}`);
    lines.push(`      Recommendation: ${w.recommendation}`);
  }

  return lines.join('\n');
}
