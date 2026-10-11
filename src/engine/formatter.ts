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

function appendHeaderAndProps(contract: ComponentContract, lines: string[]): void {
  lines.push(`Component: ${contract.component} (${contract.framework})`);
  lines.push(`File: ${contract.filePath}`);

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
}

function appendDiagnosticsAndForms(contract: ComponentContract, lines: string[]): void {
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
      const hintStr = b.backendTargetHint
        ? ` -> [Backend Target: ${b.backendTargetHint.targetIntent} | ${b.backendTargetHint.suggestedSymbols[0]}]`
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
  const { rootWrapper, dynamicBindings, visibilityDirectives, sections } = contract.layoutStructure;
  const hasData =
    rootWrapper ||
    dynamicBindings.length > 0 ||
    visibilityDirectives.length > 0 ||
    (sections && sections.length > 0);
  if (!hasData) return;

  lines.push('');
  lines.push('Layout & Dynamic Styling Structure:');
  if (rootWrapper) {
    const tokensStr = rootWrapper.layoutTokens.length > 0
      ? ` (Tokens: ${rootWrapper.layoutTokens.join(' ')})`
      : '';
    lines.push(`  - Root Wrapper: <${rootWrapper.tag}>${tokensStr}`);
  }
  if (sections && sections.length > 0) {
    lines.push(`  - Semantic Sections (${sections.length}):`);
    for (const sec of sections) {
      const customNames = sec.components
        .filter((c) => c.isCustomComponent)
        .map((c) => `<${c.name}>`)
        .join(', ');
      const rawNames = sec.rawHtmlPrimitives.map((r) => `<${r.tag}>`).join(', ');
      const compSummary = [customNames, rawNames].filter(Boolean).join(', ') || 'layout-only';
      lines.push(`      • L${sec.line} [${sec.kind}] <${sec.tag}>: ${compSummary}`);
    }
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

function appendTransportContract(contract: ComponentContract, lines: string[]): void {
  if (!contract.transportContract) return;
  const { egress, ingress, transportRisks } = contract.transportContract;
  const hasData = egress.length > 0 || ingress.length > 0 || transportRisks.length > 0;
  if (!hasData) return;

  lines.push('');
  lines.push('Bidirectional Data Transport & Boundary Contracts:');

  if (egress.length > 0) {
    lines.push(`  - Outbound Egress Payloads (${egress.length}):`);
    for (const e of egress) {
      const keysStr = e.payloadKeys.length > 0 ? ` { ${e.payloadKeys.join(', ')} }` : '';
      lines.push(
        `      • [${e.method}] ${e.endpoint} via ${e.clientKind} (${e.serialization}, casing: ${e.casing})${keysStr}`
      );
    }
  }

  if (ingress.length > 0) {
    lines.push(`  - Inbound Ingress Shapes (${ingress.length}):`);
    for (const i of ingress) {
      lines.push(
        `      • prop '${i.rootPropName}' (expected: ${i.expectedShape}, accessed fields: ${i.accessedProperties.length})`
      );
    }
  }

  if (contract.transportContract.validationSchemas && contract.transportContract.validationSchemas.length > 0) {
    lines.push(`  - Validation Schemas (${contract.transportContract.validationSchemas.length}):`);
    for (const s of contract.transportContract.validationSchemas) {
      lines.push(
        `      • ${s.name} (${s.schemaLibrary}): ${s.fields
          .map((f) => `${f.field}:${f.baseType}${f.isOptional ? '?' : ''}`)
          .join(', ')}`
      );
    }
  }

  if (contract.transportContract.errorHandling) {
    const eh = contract.transportContract.errorHandling;
    const errSourcesStr = eh.errorSources.length > 0 ? ` (Sources: ${eh.errorSources.join(', ')})` : '';
    lines.push(`  - Error Handling & 422 Rejection Audit${errSourcesStr}:`);
    lines.push(
      `      • Bound Error Fields: ${eh.boundErrorFields.length > 0 ? eh.boundErrorFields.join(', ') : '(none)'}`
    );
    if (eh.unhandledPayloadKeys.length > 0) {
      lines.push(`      • Unhandled Payload Keys: ${eh.unhandledPayloadKeys.join(', ')} [Silent 422 Risk]`);
    }
  }

  if (contract.transportContract.invalidationGraph) {
    const ig = contract.transportContract.invalidationGraph;
    if (ig.invalidations.length > 0) {
      lines.push(`  - Cache Invalidation Triggers (${ig.invalidations.length}):`);
      for (const inv of ig.invalidations) {
        lines.push(`      • L${inv.line} [${inv.mechanism}] -> ${inv.targetKeyOrUrl}`);
      }
    }
    if (ig.hasDanglingMutation) {
      lines.push(`      • Dangling Mutations (No Invalidation): ${ig.danglingMutations.join(', ')}`);
    }
  }

  if (transportRisks.length > 0) {
    lines.push(`  - Transport Risk Warnings (${transportRisks.length}):`);
    for (const r of transportRisks) {
      lines.push(`      ⚠️ ${r}`);
    }
  }
}

/**
 * Formats a ComponentContract into a token-efficient, human-readable text summary.
 */
export function formatContractAsText(contract: ComponentContract): string {
  const lines: string[] = [];

  appendHeaderAndProps(contract, lines);
  appendModelsAndVariants(contract, lines);
  appendEmitsSlotsAndExposed(contract, lines);
  appendDependenciesAndTokens(contract, lines);

  appendDiagnosticsAndForms(contract, lines);
  appendLayoutStructure(contract, lines);
  appendTransportContract(contract, lines);

  return lines.join('\n');
}
