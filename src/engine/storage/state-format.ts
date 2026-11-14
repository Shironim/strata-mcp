import type { StateChainResult, StateImpactResult, UnusedStateResult } from '../../types';

/**
 * Formats a StateImpactResult into a human-readable summary.
 */
export function formatStateImpactAsText(result: StateImpactResult): string {
  const freshness = result._meta?.syncGeneration
    ? ` | Graph generation ${result._meta.syncGeneration} | ${result._meta.cached ? 'cache hit' : 'refreshed'}`
    : '';
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms${freshness}]`
    : '';

  const lines: string[] = [
    `State Impact Analysis for: ${result.identifier}${metaBadge}`,
    `Total Dependent Components/Pages: ${result.totalConsumers}`,
  ];

  if (result.totalConsumers === 0) {
    lines.push('\n(No dependent files found for this state identifier)');
    return lines.join('\n');
  }

  if (result.roleFilter === 'mutators') {
    lines.push(`\nMutators / Actions (Trigger / Write State) [${result.mutatorsCount || 0}]:`);
    for (const c of result.consumers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const fieldsBadge = c.accessedProperties && c.accessedProperties.length > 0 ? ` [fields: ${c.accessedProperties.join(', ')}]` : '';
      const actionBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${fieldsBadge}${actionBadge}`);
    }
    return lines.join('\n');
  }

  if (result.roleFilter === 'readers') {
    lines.push(`\nReaders / Renderers (Display & Watch State) [${result.readersCount || 0}]:`);
    for (const c of result.consumers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const fieldsBadge = c.accessedProperties && c.accessedProperties.length > 0 ? ` [fields: ${c.accessedProperties.join(', ')}]` : '';
      const usageBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${fieldsBadge}${usageBadge}`);
    }
    return lines.join('\n');
  }

  // Default 'all': grouped output
  if (result.mutators && result.mutators.length > 0) {
    lines.push(`\nMutators / Actions (Trigger / Write State) [${result.mutators.length}]:`);
    for (const c of result.mutators) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const fieldsBadge = c.accessedProperties && c.accessedProperties.length > 0 ? ` [fields: ${c.accessedProperties.join(', ')}]` : '';
      const actionBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${fieldsBadge}${actionBadge}`);
    }
  }

  if (result.readers && result.readers.length > 0) {
    lines.push(`\nReaders / Renderers (Display & Watch State) [${result.readers.length}]:`);
    for (const c of result.readers) {
      const pageBadge = c.isPage ? ' [Page]' : '';
      const fieldsBadge = c.accessedProperties && c.accessedProperties.length > 0 ? ` [fields: ${c.accessedProperties.join(', ')}]` : '';
      const usageBadge = c.usageSnippet ? ` -> ${c.usageSnippet}` : '';
      lines.push(`  - ${c.path}${pageBadge}${fieldsBadge}${usageBadge}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats an UnusedStateResult into a human-readable summary.
 */
export function formatUnusedStateAsText(result: UnusedStateResult): string {
  const metaBadge = result._meta
    ? ` [Engine: ${result._meta.engine} | ${result._meta.durationMs}ms]`
    : '';

  const lines: string[] = [
    `Unused State & Composables Audit${metaBadge}`,
    `Workspace: ${result.workspaceRoot}`,
    `Total State Declarations Scanned: ${result.totalScanned}`,
    `Unused / Orphan State Found: ${result.unusedCount}`,
  ];

  if (result.unusedCount === 0) {
    lines.push('');
    lines.push('Result: All declared composables and state stores have active consumer imports.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Dead / Orphan State (0 external consumers):');
  for (const u of result.unusedState) {
    lines.push(`  - ${u.identifier} [${u.kind}]`);
    lines.push(`    File: ${u.filePath}`);
  }

  return lines.join('\n');
}

/**
 * Formats StateChainResult into readable markdown.
 */
export function formatStateChainAsText(result: StateChainResult): string {
  const lines: string[] = [];
  const freshness = result._meta?.syncGeneration
    ? ` [Graph generation ${result._meta.syncGeneration} | ${result._meta.cached ? 'cache hit' : 'refreshed'}]`
    : '';
  lines.push(`### State Dependency Chain: \`${result.identifier}\`${freshness}`);
  if (result.entryFile) {
    lines.push(`**Declared in:** \`${result.entryFile}\``);
  }

  lines.push('\n**Consumers (Upward Blast Radius):**');
  if (result.consumers.length > 0) {
    for (const c of result.consumers) {
      const indent = '  '.repeat(c.depth);
      const roleBadge = c.role ? ` [${c.role}]` : '';
      lines.push(`${indent}└─ [Depth ${c.depth}] \`${c.filePath}\` (${c.kind})${roleBadge}`);
    }
  } else {
    lines.push('  (No consumers found)');
  }

  lines.push('\n**Internal Dependencies (Downward Call Chain):**');
  if (result.dependencies.length > 0) {
    for (const d of result.dependencies) {
      const indent = '  '.repeat(d.depth);
      const fileStr = d.filePath ? ` — \`${d.filePath}\`` : '';
      lines.push(`${indent}└─ [Depth ${d.depth}] \`${d.identifier}\` (${d.kind})${fileStr}`);
    }
  } else {
    lines.push('  (No internal dependencies found)');
  }

  return lines.join('\n');
}
