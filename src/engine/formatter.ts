import type { ComponentContract, ResolvedMatch } from '../types';

/**
 * Formats match results as token-efficient human-readable text.
 */
export function formatMatchesAsText(matches: ResolvedMatch[]): string {
  if (matches.length === 0) {
    return 'No matches found.';
  }

  return matches
    .map((m) => {
      const directive = m.clientDirective ? ` [${m.clientDirective}]` : '';
      return `${m.file}:${m.line}:${m.column}${directive} - ${m.snippet}`;
    })
    .join('\n');
}

/**
 * Formats a ComponentContract into a token-efficient, human-readable text summary.
 */
export function formatContractAsText(contract: ComponentContract): string {
  const lines: string[] = [
    `Component: ${contract.component} (${contract.framework})`,
    `File: ${contract.filePath}`,
  ];

  if (contract.renderBoundary) {
    const directiveStr = contract.renderBoundary.directive
      ? ` ('${contract.renderBoundary.directive}')`
      : '';
    lines.push(`Render Boundary: ${contract.renderBoundary.boundary}${directiveStr}`);
  }

  lines.push('');
  lines.push('Props:');
  if (contract.props.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of contract.props) {
      const reqStr = p.required ? 'required' : 'optional';
      const defStr = p.default ? `, default: ${p.default}` : '';
      lines.push(`  - ${p.name}: ${p.type} (${reqStr}${defStr})`);
    }
  }

  if (contract.variants) {
    lines.push('');
    lines.push('Variants:');
    for (const [vName, vOptions] of Object.entries(contract.variants.variants)) {
      const defValue = contract.variants.defaultVariants?.[vName];
      const defStr = defValue ? ` (default: "${defValue}")` : '';
      lines.push(`  - ${vName}: [${vOptions.map((o) => `"${o}"`).join(', ')}]${defStr}`);
    }
  }

  lines.push('');
  lines.push('Emits:');
  if (contract.emits.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of contract.emits) {
      const payloadStr = e.payload ? `(payload: ${e.payload})` : '';
      lines.push(`  - ${e.name}${payloadStr}`);
    }
  }

  lines.push('');
  lines.push('Slots:');
  if (contract.slots.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of contract.slots) {
      lines.push(`  - ${s}`);
    }
  }

  if (contract.exposed && contract.exposed.length > 0) {
    lines.push('');
    lines.push('Exposed:');
    for (const exp of contract.exposed) {
      lines.push(`  - ${exp}`);
    }
  }

  if (contract.stateDependencies) {
    const { stores, contexts, composables } = contract.stateDependencies;
    if (stores.length > 0 || contexts.length > 0 || composables.length > 0) {
      lines.push('');
      lines.push('State Dependencies:');
      if (stores.length > 0) {
        lines.push(`  - Stores: ${stores.join(', ')}`);
      }
      if (contexts.length > 0) {
        lines.push(`  - Context/Injected: ${contexts.join(', ')}`);
      }
      if (composables.length > 0) {
        lines.push(`  - Composables: ${composables.join(', ')}`);
      }
    }
  }

  if (contract.dataDependencies) {
    const { serverActions, queryKeys, endpoints, mutations } = contract.dataDependencies;
    if (
      (serverActions && serverActions.length > 0) ||
      (queryKeys && queryKeys.length > 0) ||
      (endpoints && endpoints.length > 0) ||
      (mutations && mutations.length > 0)
    ) {
      lines.push('');
      lines.push('Data Lineage & Fetching:');
      if (serverActions && serverActions.length > 0) {
        lines.push(`  - Server Actions: ${serverActions.join(', ')}`);
      }
      if (queryKeys && queryKeys.length > 0) {
        lines.push(`  - Query Keys: ${queryKeys.join(', ')}`);
      }
      if (endpoints && endpoints.length > 0) {
        lines.push(`  - API Endpoints: ${endpoints.join(', ')}`);
      }
      if (mutations && mutations.length > 0) {
        lines.push(`  - Form Mutations: ${mutations.join(', ')}`);
      }
    }
  }

  if (contract.renderBoundary?.violations && contract.renderBoundary.violations.length > 0) {
    lines.push('');
    lines.push('Boundary Warnings / Violations:');
    for (const v of contract.renderBoundary.violations) {
      lines.push(`  - [${v.severity.toUpperCase()}] ${v.code}: ${v.message}`);
      if (v.hint) {
        lines.push(`    Hint: ${v.hint}`);
      }
    }
  }

  return lines.join('\n');
}
