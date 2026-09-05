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
      const unionStr = p.unionMembers && p.unionMembers.length > 0 ? ` [options: ${p.unionMembers.join(' | ')}]` : '';
      lines.push(`  - ${p.name}: ${p.type} (${reqStr}${defStr})${unionStr}`);
    }
  }

  if (contract.inferredProps && contract.inferredProps.length > 0) {
    lines.push('');
    lines.push('Inferred Props Structure (via template & script AST):');
    for (const ip of contract.inferredProps) {
      lines.push(`  - ${ip.propName}:`);
      for (const prop of ip.properties) {
        const usage = prop.usageSnippet ? ` (${prop.usageSnippet})` : '';
        const typeStr = prop.inferredType ? `: ${prop.inferredType}` : '';
        lines.push(`      • .${prop.property}${typeStr}${usage}`);
      }
    }
  }

  if (contract.models && contract.models.length > 0) {
    lines.push('');
    lines.push('Models (Two-Way Bindings):');
    for (const m of contract.models) {
      const reqStr = m.required ? ' [REQUIRED]' : '';
      const defStr = m.default ? ` (default: ${m.default})` : '';
      lines.push(`  - v-model${m.name === 'modelValue' ? '' : `:${m.name}`} (${m.type || 'any'})${reqStr}${defStr}`);
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
      const payloadStr = e.payload ? ` (payload: ${e.payload})` : '';
      lines.push(`  - ${e.name}${payloadStr}`);
    }
  }

  lines.push('');
  lines.push('Slots:');
  if (contract.slots.length === 0) {
    lines.push('  (none)');
  } else if (contract.slotDetails && contract.slotDetails.length > 0) {
    for (const s of contract.slotDetails) {
      let scopedStr = '';
      if (s.isScoped) {
        if (s.payload && Object.keys(s.payload).length > 0) {
          const payloadEntries = Object.entries(s.payload)
            .map(([k, v]) => (v ? `${k}: ${v}` : k))
            .join(', ');
          scopedStr = ` (scoped payload: { ${payloadEntries} })`;
        } else {
          scopedStr = ` (scoped: ${s.bindings?.join(', ') || 'true'})`;
        }
      }
      lines.push(`  - ${s.name}${scopedStr}`);
    }
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

  if (contract.globalSymbols && contract.globalSymbols.length > 0) {
    lines.push('');
    lines.push('External / Global Symbols:');
    for (const g of contract.globalSymbols) {
      const hint = g.hint ? ` (${g.hint})` : '';
      lines.push(`  - ${g.name}: ${g.category}${hint}`);
    }
  }

  if (contract.styleTokens) {
    const { layoutTraps, zIndices, overflow, positioning } = contract.styleTokens;
    if (layoutTraps.length > 0 || zIndices.length > 0 || overflow.length > 0 || positioning.length > 0) {
      lines.push('');
      lines.push('Layout & Style Tokens (Tailwind/CSS):');
      if (layoutTraps.length > 0) {
        lines.push(`  - Layout Traps: ${layoutTraps.join(', ')}`);
      }
      if (zIndices.length > 0) {
        lines.push(`  - Z-Indices: ${zIndices.join(', ')}`);
      }
      if (overflow.length > 0) {
        lines.push(`  - Overflow: ${overflow.join(', ')}`);
      }
      if (positioning.length > 0) {
        lines.push(`  - Positioning: ${positioning.join(', ')}`);
      }
    }
  }

  if (contract.reactivitySmells && contract.reactivitySmells.length > 0) {
    lines.push('');
    lines.push(`Reactivity Smells (${contract.reactivitySmells.length} detected):`);
    for (const s of contract.reactivitySmells) {
      const icon = s.severity === 'error' ? '❌' : '⚠️';
      lines.push(`  ${icon} [${s.severity.toUpperCase()}] Line ${s.line}: ${s.message}`);
      if (s.snippet) {
        lines.push(`     Code: \`${s.snippet}\``);
      }
      lines.push(`     Fix: ${s.recommendation}`);
    }
  }

  if (contract.boundaryContracts && contract.boundaryContracts.length > 0) {
    lines.push('');
    lines.push(`Data Fetching & Boundary Contracts (${contract.boundaryContracts.length} detected):`);
    for (const b of contract.boundaryContracts) {
      const lineStr = b.loc ? `Line ${b.loc.line}: ` : '';
      const payloadStr = b.payloadKeys && b.payloadKeys.length > 0 ? ` [payload: ${b.payloadKeys.join(', ')}]` : '';
      lines.push(`  - ${lineStr}[${b.boundaryType}] ${b.method} ${b.targetEndpoint}${payloadStr}`);
    }
  }

  if (contract.formContracts && contract.formContracts.length > 0) {
    lines.push('');
    lines.push('Form & Field Contracts:');
    for (const f of contract.formContracts) {
      const multipartStr = f.isMultipart ? ' (multipart/form-data)' : '';
      lines.push(`  - Form binding: "${f.binding || 'form'}"${multipartStr}`);
      for (const field of f.fields) {
        const reqStr = field.required ? ' [REQUIRED]' : '';
        lines.push(`      • ${field.key} (${field.type})${reqStr}`);
      }
    }
  }

  return lines.join('\n');
}
