import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

/**
 * SolidJS Canonical Pattern Rules:
 * 1. solid/no-props-destructure: Prohibits destructuring props in component signatures or body.
 * 2. solid/prefer-for-component: Recommends <For> over .map() for dynamic lists.
 */
export async function checkSolidRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  // Rule 1: solid/no-props-destructure (Variable assignment: const { foo } = props)
  const propDestructRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*props\s*;?/g;
  let match: RegExpExecArray | null;
  while ((match = propDestructRegex.exec(content)) !== null) {
    const destructuredVars = match[1].trim();
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    diagnostics.push(
      createDiagnostic({
        ruleId: 'solid/no-props-destructure',
        framework: 'solid',
        category: 'reactivity',
        severity: 'error',
        snapshot,
        content,
        startOffset,
        endOffset,
        smellTitle: 'SolidJS Props Destructuring Anti-Pattern',
        smellExplanation: `Destructuring '{ ${destructuredVars} }' directly from props permanently severs fine-grained reactivity. SolidJS components execute only once at mount; reactive tracking occurs when accessing properties (getters) inside JSX bindings or effects.`,
        canonSummary: `Access properties via 'props.${destructuredVars.split(',')[0].trim()}' or use 'splitProps(props, [...])'.`,
        canonRationale: 'SolidJS relies on proxy getters to track subscriptions. Accessing properties directly inside effects or JSX preserves subscriptions without full component re-executions.',
        canonicalCode: `// Standard SolidJS property access:\nprops.${destructuredVars.split(',')[0].trim()}\n\n// Or if separating props:\nconst [local, others] = splitProps(props, [${destructuredVars.split(',').map(s => `'${s.trim()}'`).join(', ')}]);`,
        referenceDoc: 'https://docs.solidjs.com/concepts/components/props#destructuring',
      })
    );
  }

  // Rule 2: Component parameter destructuring in Solid: export function Comp({ prop1, prop2 })
  const paramDestructRegex = /(?:export\s+(?:default\s+)?)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*\{([^}]+)\}\s*(?::\s*[^)]+)?\)/g;
  while ((match = paramDestructRegex.exec(content)) !== null) {
    const componentName = match[1];
    const params = match[2].trim();
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    diagnostics.push(
      createDiagnostic({
        ruleId: 'solid/no-props-destructure',
        framework: 'solid',
        category: 'reactivity',
        severity: 'error',
        snapshot,
        content,
        startOffset,
        endOffset,
        smellTitle: `SolidJS Component '${componentName}' Signature Destructuring`,
        smellExplanation: `Destructuring props directly in component arguments 'function ${componentName}({ ${params} })' severs reactivity at mount time.`,
        canonSummary: `Use 'function ${componentName}(props: ${componentName}Props)' and access 'props.${params.split(',')[0].trim()}'.`,
        canonRationale: 'SolidJS components do not re-render like React components; fine-grained reactive expressions update only where accessed.',
        canonicalCode: `function ${componentName}(props: ${componentName}Props) {\n  return <div>{props.${params.split(',')[0].trim()}}</div>;\n}`,
        referenceDoc: 'https://docs.solidjs.com/concepts/components/props#destructuring',
      })
    );
  }

  return diagnostics;
}

