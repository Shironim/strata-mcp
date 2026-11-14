import { relative } from 'node:path';
import type { ComponentContract, ResolvedMatch } from '../types';

/**
 * Formats match results as token-efficient human-readable text.
 */
export function formatMatchesAsText(matches: ResolvedMatch[], rootDir?: string): string {
  if (matches.length === 0) {
    return 'No matches found.';
  }

  const lines = matches.map((m) => {
    const usage = m.usageKind ? ` [${m.usageKind}]` : '';
    const directive = m.clientDirective ? ` [${m.clientDirective}]` : '';
    let displayFile = m.file;
    if (rootDir) {
      const rel = relative(rootDir, m.file);
      if (rel && !rel.startsWith('..')) displayFile = rel;
    }
    const loc = m.column !== undefined ? `${displayFile}:${m.line}:${m.column}` : `${displayFile}:${m.line}`;
    return `${loc}${usage}${directive} - ${m.snippet}`;
  });
  return rootDir ? `Root: ${rootDir}\n${lines.join('\n')}` : lines.join('\n');
}

function appendHeaderAndProps(contract: ComponentContract, lines: string[]): void {
  lines.push(`Component: ${contract.component} (${contract.framework})`);
  lines.push(`File: ${contract.filePath}`);
  if (contract.projectContext) {
    const context = contract.projectContext;
    lines.push(`Project owner: ${context.ownerRoot ?? 'unverified'} (${context.status}); application=${context.applicationFramework ?? 'unverified'}; app-root=${context.appRoot ?? 'unverified'}`);
    for (const issue of context.diagnostics) lines.push(`Ownership partial (${issue.code}): ${issue.reason}`);
  }

  if (contract.renderBoundary) {
    const directiveStr = contract.renderBoundary.directive
      ? ` ('${contract.renderBoundary.directive}')`
      : '';
    lines.push(`Render Boundary: ${contract.renderBoundary.boundary}${directiveStr}`);
    const evidence = contract.renderBoundary.evidence;
    lines.push(evidence
      ? `Boundary evidence: ${evidence.basis}/${evidence.resolution} (${evidence.method}): ${evidence.reason ?? 'No additional reason supplied.'}`
      : 'Boundary evidence: unavailable; runtime render environment is unverified.');
    lines.push('Hydration flag describes structural interpretation; runtime behavior is not verified.');
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
      const depStr = p.deprecated !== undefined ? ` ⚠️ [DEPRECATED${typeof p.deprecated === 'string' ? `: ${p.deprecated}` : ''}]` : '';
      const descStr = p.description ? ` - ${p.description}` : '';
      lines.push(`  - ${p.name}: ${p.type} (${reqStr}${defStr})${unionStr}${depStr}${descStr}`);
    }
  }
}

function appendModelsAndVariants(contract: ComponentContract, lines: string[]): void {
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
}

function appendEmitsSlotsAndExposed(contract: ComponentContract, lines: string[]): void {
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
}

function appendDependenciesAndTokens(contract: ComponentContract, lines: string[]): void {
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
    for (const issue of contract.stateDependencies.diagnostics ?? []) lines.push(`State dependency partial (${issue.code}): ${issue.reason}`);
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
}

function appendDiagnosticsAndForms(contract: ComponentContract, lines: string[]): void {

  if (contract.boundaryContracts && contract.boundaryContracts.length > 0) {
    lines.push('');
    lines.push(`Data Fetching & Boundary Contracts (${contract.boundaryContracts.length} detected):`);
    for (const b of contract.boundaryContracts) {
      const lineStr = b.loc ? `Line ${b.loc.line}: ` : '';
      const payloadStr = b.payloadKeys && b.payloadKeys.length > 0 ? ` [payload: ${b.payloadKeys.join(', ')}]` : '';
      const hintStr = b.backendTargetHint
        ? ` -> [Backend Target (Heuristic): ${b.backendTargetHint.targetIntent} | ${b.backendTargetHint.suggestedSymbols[0]} (verify actual routes)]`
        : '';
      lines.push(`  - ${lineStr}[${b.boundaryType}] ${b.method} ${b.targetEndpoint}${payloadStr}${hintStr}`);
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
}

function appendLayoutStructure(contract: ComponentContract, lines: string[]): void {
  if (!contract.layoutStructure) return;
  const { rootWrapper, dynamicBindings, visibilityDirectives } = contract.layoutStructure;
  const hasData =
    rootWrapper ||
    dynamicBindings.length > 0 ||
    visibilityDirectives.length > 0;
  if (!hasData) return;

  lines.push('');
  lines.push('Layout & Dynamic Styling Structure:');
  if (rootWrapper) {
    const tokensStr = rootWrapper.layoutTokens.length > 0
      ? ` (Tokens: ${rootWrapper.layoutTokens.join(' ')})`
      : '';
    lines.push(`  - Root Wrapper: <${rootWrapper.tag}>${tokensStr}`);
  }
  if (dynamicBindings.length > 0) {
    lines.push(`  - Dynamic Class Bindings (${dynamicBindings.length}):`);
    for (const db of dynamicBindings) {
      lines.push(`      • L${db.line} <${db.tag} ${db.directive}>: [${db.tokens.join(', ')}] when (${db.condition})`);
    }
  }
  if (visibilityDirectives.length > 0) {
    lines.push(`  - Visibility Directives (${visibilityDirectives.length}):`);
    for (const vd of visibilityDirectives) {
      lines.push(`      • L${vd.line} <${vd.tag} ${vd.directive}="${vd.expression}">`);
    }
  }
}

/**
 * Formats a ComponentContract into a token-efficient, human-readable text summary.
 */
export function formatContractAsText(contract: ComponentContract): string {
  const lines: string[] = [];

  appendHeaderAndProps(contract, lines);
  for (const [name, metadata] of [['Nuxt page metadata', contract.nuxtPageMeta], ['Next segment config', contract.nextSegmentConfig]] as const) {
    if (metadata) lines.push(`${name}: ${JSON.stringify(metadata)}`);
  }
  appendModelsAndVariants(contract, lines);
  appendEmitsSlotsAndExposed(contract, lines);
  appendDependenciesAndTokens(contract, lines);

  appendDiagnosticsAndForms(contract, lines);
  appendLayoutStructure(contract, lines);

  return lines.join('\n');
}
