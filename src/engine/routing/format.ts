import { join } from 'node:path';
import type { RouteManifestResult } from '../../types';

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
    const appMatch = r.filePath.replace(/\\/g, '/').match(/(?:^|\/)((?:apps|packages)\/[^/]+)\//);
    const appBadge = appMatch ? ` [${appMatch[1]}]` : '';
    const paramStr =
      r.params.length > 0 ? ` (params: ${r.params.map((p) => p.name).join(', ')})` : '';
    const handlerStr = r.handlers ? ` (handlers: ${r.handlers.join(', ')})` : '';
    lines.push(`  ${r.path} [${r.type}]${appBadge}${paramStr}${handlerStr}`);
    lines.push(`    File: ${r.filePath}`);
    if (r.layouts && r.layouts.length > 0) {
      lines.push(`    Layouts: ${r.layouts.join(', ')}`);
    }
    if (r.nuxtPageMeta?.alias && r.nuxtPageMeta.alias.length > 0) {
      lines.push(`    Aliases: ${r.nuxtPageMeta.alias.join(', ')}`);
    }
    if (r.nextEffectiveSegmentConfig) {
      const effective = r.nextEffectiveSegmentConfig;
      lines.push(`    Observed segment config: ${JSON.stringify(effective.config)} (freshness: ${effective.freshness}; runtime behavior unverified)`);
      for (const issue of effective.unresolvedFields) lines.push(`    Partial ${issue.field}: ${issue.reason}`);
    }
  }

  return lines.join('\n');
}
