import ts from 'typescript';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { getProjectEcosystem } from '../framework-detector';
import { findProjectRoot } from '../path-resolver';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';
import { parseSvelte } from '../svelte-sfc';

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isParenthesizedExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression;
  }
  return curr;
}

function isEffectCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expr = unwrapExpression(node.expression);
  if (ts.isIdentifier(expr) && (expr.text === '$effect' || expr.text === '$effect.pre')) return true;
  if (ts.isPropertyAccessExpression(expr)) {
    return ts.isIdentifier(expr.expression) && expr.expression.text === '$effect';
  }
  return false;
}

/**
 * Svelte Canonical Pattern Rules:
 * 1. svelte/prefer-runes-props (warning, legacy-syntax)
 * 2. svelte/prefer-runes-state-derived (warning, legacy-syntax)
 * 3. svelte/no-effect-for-derived-state (error, reactivity)
 * 4. svelte/no-non-bindable-prop-mutation (error, reactivity)
 * 5. svelte/prefer-snippets-over-slots (warning, legacy-syntax)
 * 6. svelte/prefer-callback-props-over-dispatcher (warning, legacy-syntax)
 * 7. svelte/each-missing-key (warning, rendering)
 */
export async function checkSvelteRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  let svelteMajor = options?.majorVersion ?? 5;
  if (options?.majorVersion === undefined) {
    try {
      const root = findProjectRoot(snapshot.file);
      const eco = getProjectEcosystem(root);
      if (eco.frameworks.svelte?.major) {
        svelteMajor = eco.frameworks.svelte.major;
      }
    } catch {
      svelteMajor = 5;
    }
  }

  const descriptor = parseSvelte(content, snapshot.file);
  const nonBindableProps = new Set<string>();
  const bindableProps = new Set<string>();

  // =========================================================================
  // 1. Analyze Script Blocks (Instance & Module)
  // =========================================================================
  const scriptBlocks = [descriptor.module, descriptor.instance].filter(Boolean);

  for (const block of scriptBlocks) {
    if (!block) continue;
    const scriptContent = block.content;
    const bodyStart = block.loc.start.offset;
    const sf = ts.createSourceFile('svelte-canon.ts', scriptContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visitScript = (node: ts.Node) => {
      // Collect $props declarations
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const unwrapped = unwrapExpression(node.initializer);
        if (ts.isCallExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === '$props') {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const elem of node.name.elements) {
              if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
                const propName = (elem.propertyName && ts.isIdentifier(elem.propertyName))
                  ? elem.propertyName.text
                  : elem.name.text;

                let isBindable = false;
                if (elem.initializer) {
                  const initUnwrapped = unwrapExpression(elem.initializer);
                  if (ts.isCallExpression(initUnwrapped) && ts.isIdentifier(initUnwrapped.expression) && initUnwrapped.expression.text === '$bindable') {
                    isBindable = true;
                  }
                }

                if (isBindable) {
                  bindableProps.add(propName);
                } else {
                  nonBindableProps.add(propName);
                }
              }
            }
          }
        }
      }

      // Rule 3: svelte/no-effect-for-derived-state
      if (svelteMajor >= 5 && isEffectCall(node)) {
        const callNode = node as ts.CallExpression;
        const callback = callNode.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const checkBody = (bodyNode: ts.Node) => {
            if (ts.isBinaryExpression(bodyNode) && ts.isIdentifier(bodyNode.left)) {
              const op = bodyNode.operatorToken.kind;
              if (
                op === ts.SyntaxKind.EqualsToken ||
                op === ts.SyntaxKind.PlusEqualsToken ||
                op === ts.SyntaxKind.MinusEqualsToken
              ) {
                const varName = bodyNode.left.text;
                const exprText = bodyNode.right.getText(sf).trim();
                const startOffset = bodyStart + bodyNode.getStart(sf);
                const endOffset = bodyStart + bodyNode.getEnd();

                diagnostics.push(
                  createDiagnostic({
                    ruleId: 'svelte/no-effect-for-derived-state',
                    framework: 'svelte',
                    category: 'reactivity',
                    severity: 'error',
                    snapshot,
                    content,
                    startOffset,
                    endOffset,
                    smellTitle: 'Mutating State Inside $effect for Derived Values',
                    smellExplanation: `Mutating state '${varName}' inside an $effect triggers redundant render cascades and risks infinite update loops (effect_update_depth_exceeded).`,
                    canonSummary: `Use '$derived(${exprText})' or '$derived.by(() => ...)' instead of mutating state in '$effect'.`,
                    canonRationale: 'Runes cleanly separate pure synchronous derivations ($derived) from external asynchronous side-effects ($effect).',
                    canonicalCode: `let ${varName} = $derived(${exprText});`,
                    referenceDoc: 'https://svelte.dev/docs/svelte/$derived',
                  })
                );
              }
            }
            ts.forEachChild(bodyNode, checkBody);
          };
          checkBody(callback.body);
        }
      }

      // Rule 4: svelte/no-non-bindable-prop-mutation (in script)
      if (svelteMajor >= 5) {
        if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
          const varName = node.left.text;
          if (nonBindableProps.has(varName)) {
            const op = node.operatorToken.kind;
            if (
              op === ts.SyntaxKind.EqualsToken ||
              op === ts.SyntaxKind.PlusEqualsToken ||
              op === ts.SyntaxKind.MinusEqualsToken ||
              op === ts.SyntaxKind.AsteriskEqualsToken ||
              op === ts.SyntaxKind.SlashEqualsToken
            ) {
              const startOffset = bodyStart + node.getStart(sf);
              const endOffset = bodyStart + node.getEnd();

              diagnostics.push(
                createDiagnostic({
                  ruleId: 'svelte/no-non-bindable-prop-mutation',
                  framework: 'svelte',
                  category: 'reactivity',
                  severity: 'error',
                  snapshot,
                  content,
                  startOffset,
                  endOffset,
                  smellTitle: 'Mutating Non-Bindable Prop in Svelte 5',
                  smellExplanation: `Prop '${varName}' is one-way in Svelte 5. Mutating it without '$bindable()' causes parent-child state divergence or runtime warnings.`,
                  canonSummary: `Mark prop as '$bindable()' if two-way mutation is intended: 'let { ${varName} = $bindable(...) } = $props();'`,
                  canonRationale: 'Svelte 5 requires explicit opt-in via $bindable() for two-way mutable bindings.',
                  canonicalCode: `let { ${varName} = $bindable() } = $props();`,
                  referenceDoc: 'https://svelte.dev/docs/svelte/$bindable',
                })
              );
            }
          }
        } else if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          ts.isIdentifier(node.operand)
        ) {
          const varName = node.operand.text;
          if (nonBindableProps.has(varName)) {
            const startOffset = bodyStart + node.getStart(sf);
            const endOffset = bodyStart + node.getEnd();

            diagnostics.push(
              createDiagnostic({
                ruleId: 'svelte/no-non-bindable-prop-mutation',
                framework: 'svelte',
                category: 'reactivity',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: 'Mutating Non-Bindable Prop in Svelte 5',
                smellExplanation: `Prop '${varName}' is one-way in Svelte 5. Mutating it with '${node.getText(sf)}' causes parent-child state divergence.`,
                canonSummary: `Mark prop as '$bindable()' if two-way mutation is intended: 'let { ${varName} = $bindable(...) } = $props();'`,
                canonRationale: 'Svelte 5 requires explicit opt-in via $bindable() for two-way mutable bindings.',
                canonicalCode: `let { ${varName} = $bindable() } = $props();`,
                referenceDoc: 'https://svelte.dev/docs/svelte/$bindable',
              })
            );
          }
        }
      }

      // Rule 6: svelte/prefer-callback-props-over-dispatcher (createEventDispatcher in script)
      if (svelteMajor >= 5 && ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'createEventDispatcher') {
          const startOffset = bodyStart + node.getStart(sf);
          const endOffset = bodyStart + node.getEnd();

          diagnostics.push(
            createDiagnostic({
              ruleId: 'svelte/prefer-callback-props-over-dispatcher',
              framework: 'svelte',
              category: 'legacy-syntax',
              severity: 'warning',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: 'Deprecated createEventDispatcher in Svelte 5 Project',
              smellExplanation: `'createEventDispatcher' is deprecated in Svelte 5. Event dispatching has been replaced by standard callback props in $props().`,
              canonSummary: `Replace with callback prop: 'let { onSave }: { onSave?: (id: string) => void } = $props();'`,
              canonRationale: 'Callback props eliminate CustomEvent wrapper overhead and provide superior TypeScript inference.',
              canonicalCode: `let { onSave }: { onSave?: (id: string) => void } = $props();`,
              referenceDoc: 'https://svelte.dev/docs/svelte/v5-migration-guide#Event-changes',
            })
          );
        }
      }

      ts.forEachChild(node, visitScript);
    };

    visitScript(sf);
  }

  // =========================================================================
  // 2. Svelte 5 Canonical Rules on Full Content (Regex / Template)
  // =========================================================================
  if (svelteMajor >= 5) {
    // Rule 1: svelte/prefer-runes-props
    const exportLetRegex = /export\s+let\s+([A-Za-z0-9_]+)(?:\s*:\s*[^=;]+)?(?:\s*=\s*[^;]+)?;/g;
    let match: RegExpExecArray | null;
    while ((match = exportLetRegex.exec(content)) !== null) {
      const propName = match[1];
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-runes-props',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Legacy Svelte 4 Prop Syntax in Svelte 5 Project',
          smellExplanation: `Using 'export let ${propName}' is legacy syntax in Svelte 5. Modern Svelte uses the '$props()' rune for type-safe, fine-grained props declaration.`,
          canonSummary: `Replace with 'let { ${propName} } = $props();'`,
          canonRationale: 'Svelte 5 Runes provide universal fine-grained reactivity across both .svelte components and .svelte.js/.svelte.ts modules.',
          canonicalCode: `let { ${propName} } = $props();`,
          referenceDoc: 'https://svelte.dev/docs/svelte/$props',
        })
      );
    }

    // Rule 2: svelte/prefer-runes-state-derived
    const reactiveStatementRegex = /^\s*(\$:\s*(?:([A-Za-z0-9_]+)\s*=\s*([^;\n]+)|(\{[\s\S]*?\}|[^;\n]+)));/gm;
    while ((match = reactiveStatementRegex.exec(content)) !== null) {
      const fullMatch = match[1];
      const varName = match[2];
      const expr = match[3];
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      const canonCode = varName && expr
        ? `let ${varName} = $derived(${expr.trim()});`
        : `$effect(() => { ... });`;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-runes-state-derived',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Legacy Svelte 4 Reactive Declaration ($:)',
          smellExplanation: `Labelled statement '$: ...' is legacy syntax in Svelte 5. State derivations and side-effects should use '$derived()' or '$effect()'.`,
          canonSummary: `Replace '$:' with '$derived()' or '$effect()'.`,
          canonRationale: 'Runes make reactivity explicit, predictable, and functional inside and outside components.',
          canonicalCode: canonCode,
          referenceDoc: 'https://svelte.dev/docs/svelte/$derived',
        })
      );
    }

    // Rule 4 (template): svelte/no-non-bindable-prop-mutation with bind:value={prop}
    for (const propName of nonBindableProps) {
      const bindRegex = new RegExp(`\\bbind:[a-zA-Z0-9_-]+=\\{${propName}\\}`, 'g');
      let bindMatch: RegExpExecArray | null;
      while ((bindMatch = bindRegex.exec(content)) !== null) {
        const startOffset = bindMatch.index;
        const endOffset = startOffset + bindMatch[0].length;

        diagnostics.push(
          createDiagnostic({
            ruleId: 'svelte/no-non-bindable-prop-mutation',
            framework: 'svelte',
            category: 'reactivity',
            severity: 'error',
            snapshot,
            content,
            startOffset,
            endOffset,
            smellTitle: 'Binding to Non-Bindable Prop in Svelte 5',
            smellExplanation: `Prop '${propName}' is bound with '${bindMatch[0]}' but was not declared with '$bindable()' in $props().`,
            canonSummary: `Declare prop with '$bindable()': 'let { ${propName} = $bindable(...) } = $props();'`,
            canonRationale: 'Svelte 5 requires explicit opt-in via $bindable() for two-way mutable bindings.',
            canonicalCode: `let { ${propName} = $bindable() } = $props();`,
            referenceDoc: 'https://svelte.dev/docs/svelte/$bindable',
          })
        );
      }
    }

    // Rule 5: svelte/prefer-snippets-over-slots (<slot> element or slot="..." attribute)
    const slotTagRegex = /<slot\b([^>]*)\/?>/gi;
    let slotTagMatch: RegExpExecArray | null;
    while ((slotTagMatch = slotTagRegex.exec(content)) !== null) {
      const startOffset = slotTagMatch.index;
      const endOffset = startOffset + slotTagMatch[0].length;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-snippets-over-slots',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Deprecated <slot> Element in Svelte 5 Project',
          smellExplanation: `The '<slot>' element is deprecated in Svelte 5. Modern Svelte replaces slots with typed Snippets ({#snippet}) and '{@render ...}'.`,
          canonSummary: `Use Snippets ('{#snippet ...}' and '{@render ...}') instead of '<slot>'.`,
          canonRationale: 'Snippets are first-class, typed template functions that can be passed as props and rendered dynamically.',
          canonicalCode: `let { header, children }: { header?: Snippet; children?: Snippet } = $props();\n{@render children?.()}`,
          referenceDoc: 'https://svelte.dev/docs/svelte/snippet',
        })
      );
    }

    // Rule 6 (template): svelte/prefer-callback-props-over-dispatcher (on:event directive)
    const onDirectiveRegex = /\bon:([a-zA-Z0-9_-]+)(?:=(?:["'][^"']*["']|\{[^}]*\}))?/g;
    let onMatch: RegExpExecArray | null;
    while ((onMatch = onDirectiveRegex.exec(content)) !== null) {
      const rawEvent = onMatch[1];
      const startOffset = onMatch.index;
      const endOffset = startOffset + onMatch[0].length;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/prefer-callback-props-over-dispatcher',
          framework: 'svelte',
          category: 'legacy-syntax',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Deprecated on:event Directive in Svelte 5',
          smellExplanation: `The directive 'on:${rawEvent}' is deprecated in Svelte 5. Use standard DOM attributes ('on${rawEvent}={...}') instead.`,
          canonSummary: `Replace 'on:${rawEvent}' with 'on${rawEvent}={...}'.`,
          canonRationale: 'Standard event attributes align with DOM standards, reduce CustomEvent wrapping overhead, and provide strict TypeScript checking.',
          canonicalCode: `on${rawEvent}={handle${rawEvent.charAt(0).toUpperCase() + rawEvent.slice(1)}}`,
          referenceDoc: 'https://svelte.dev/docs/svelte/v5-migration-guide#Event-changes',
        })
      );
    }
  }

  // Rule 7: svelte/each-missing-key (applicable across Svelte 4 and 5)
  const eachRegex = /\{#each\s+([A-Za-z0-9_$.]+)\s+as\s+([A-Za-z0-9_$.]+)(\s*\([^)]*\))?\}([\s\S]*?)\{\/each\}/g;
  let eachMatch: RegExpExecArray | null;
  while ((eachMatch = eachRegex.exec(content)) !== null) {
    const listExpr = eachMatch[1];
    const itemVar = eachMatch[2];
    const keyExpr = eachMatch[3];
    const eachBody = eachMatch[4];

    // If key expression is missing and body contains elements or components
    if (!keyExpr && (/<[A-Za-z][A-Za-z0-9_-]*/.test(eachBody))) {
      const startOffset = eachMatch.index;
      const endOffset = startOffset + eachMatch[0].indexOf('}') + 1;

      diagnostics.push(
        createDiagnostic({
          ruleId: 'svelte/each-missing-key',
          framework: 'svelte',
          category: 'rendering',
          severity: 'warning',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Missing Unique Key in {#each} Block',
          smellExplanation: `Iterating '${listExpr}' without an explicit key '(${itemVar}.id)' causes in-place mutations, component state desynchronization, and broken transitions.`,
          canonSummary: `Add a unique key in parentheses: '{#each ${listExpr} as ${itemVar} (${itemVar}.id)}'`,
          canonRationale: 'Keyed each blocks guarantee deterministic DOM reconciliation and preserve internal child component state across list updates.',
          canonicalCode: `{#each ${listExpr} as ${itemVar} (${itemVar}.id)}\n  <Card {${itemVar}} />\n{/each}`,
          referenceDoc: 'https://svelte.dev/docs/svelte/each',
        })
      );
    }
  }

  return diagnostics;
}

