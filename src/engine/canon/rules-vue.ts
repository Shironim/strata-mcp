import ts from 'typescript';
import { NodeTypes, parse as parseVueTemplate, type DirectiveNode, type ElementNode, type TemplateChildNode } from '@vue/compiler-dom';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { getProjectEcosystem } from '../framework-detector';
import { findProjectRoot } from '../path-resolver';
import { parseSfc } from '../splitter';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

/**
 * Vue Canonical Pattern Rules Engine:
 * 1. vue/no-prop-mutation: Prohibits mutating props via v-model or direct assignment in script.
 * 2. vue/props-destructure-version: Flags destructure in Vue < 3.5; recommends native destructure over withDefaults in Vue >= 3.5.
 * 3. vue/no-reactive-destructure: Flags destructuring reactive() object without toRefs().
 * 4. vue/no-v-if-with-v-for: Prohibits placing v-if and v-for on the same element.
 * 5. vue/require-v-for-key: Flags v-for missing :key or using array index as key.
 * 6. vue/no-async-computed: Prohibits async functions inside computed().
 * 7. vue/computed-over-watch: Recommends computed() instead of watch() assigning derived state.
 * 8. vue/prefer-define-model: In Vue >= 3.4, recommends defineModel() over boilerplate modelValue prop + update emit.
 */
export async function checkVueRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  // Determine Vue Version from Project Ecosystem
  let vueMajor = 3;
  let vueMinor = 5; // Default assumption modern Vue 3.5+
  try {
    const root = findProjectRoot(snapshot.file);
    const eco = getProjectEcosystem(root);
    if (eco.frameworks.vue?.major) {
      vueMajor = eco.frameworks.vue.major;
      vueMinor = eco.frameworks.vue.minor ?? 0;
    }
  } catch {
    // Default to modern Vue 3.5+
  }

  const isPreVue35 = vueMajor < 3 || (vueMajor === 3 && vueMinor < 5);
  const isVue34Plus = vueMajor > 3 || (vueMajor === 3 && vueMinor >= 4);
  const isVue35Plus = vueMajor > 3 || (vueMajor === 3 && vueMinor >= 5);

  const parsed = parseSfc(content, snapshot.file);

  // =========================================================================
  // 1. Template AST Checks (@vue/compiler-dom)
  // =========================================================================
  if (parsed.template) {
    const templateBlock = parsed.template;
    try {
      const templateAst = parseVueTemplate(templateBlock.content);

      function walkTemplate(node: TemplateChildNode) {
        if (node.type === NodeTypes.ELEMENT) {
          const el = node as ElementNode;
          const directives = el.props.filter((p): p is DirectiveNode => p.type === NodeTypes.DIRECTIVE);

          const forDir = directives.find(d => d.name === 'for');
          const ifDir = directives.find(d => d.name === 'if');
          const modelDirs = directives.filter(d => d.name === 'model');
          const keyDir = directives.find(d => d.name === 'bind' && d.arg && d.arg.type === NodeTypes.SIMPLE_EXPRESSION && (d.arg as any).content === 'key');

          // Rule: vue/no-v-if-with-v-for
          if (forDir && ifDir) {
            const startOffset = templateBlock.loc.start.offset + el.loc.start.offset;
            const endOffset = templateBlock.loc.start.offset + el.loc.end.offset;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'vue/no-v-if-with-v-for',
                framework: 'vue',
                category: 'rendering',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `v-if and v-for on the same <${el.tag}> element`,
                smellExplanation: `In Vue 3, v-if has a higher precedence than v-for. The condition will be evaluated before the loop variable exists, leading to reference errors.`,
                canonSummary: `Filter items using a computed property or wrap with <template v-for="...">.`,
                canonRationale: 'Separating filtering logic into computed properties keeps templates declarative and avoids redundant iteration during renders.',
                canonicalCode: `<template v-for="item in activeItems" :key="item.id">\n  <${el.tag}>...</${el.tag}>\n</template>`,
                referenceDoc: 'https://vuejs.org/guide/essentials/list.html#v-for-with-v-if',
              })
            );
          }

          // Rule: vue/require-v-for-key
          if (forDir) {
            const forOffset = templateBlock.loc.start.offset + forDir.loc.start.offset;
            const forEnd = templateBlock.loc.start.offset + forDir.loc.end.offset;

            if (!keyDir) {
              diagnostics.push(
                createDiagnostic({
                  ruleId: 'vue/require-v-for-key',
                  framework: 'vue',
                  category: 'performance',
                  severity: 'error',
                  snapshot,
                  content,
                  startOffset: forOffset,
                  endOffset: forEnd,
                  smellTitle: `v-for loop on <${el.tag}> missing :key binding`,
                  smellExplanation: `Without an explicit unique :key, Vue uses an in-place patch strategy which can cause subtle rendering bugs and lose internal component state when list order changes.`,
                  canonSummary: `Bind :key with a unique domain identifier: :key="item.id".`,
                  canonRationale: 'Keys provide stable identities for virtual DOM nodes across re-orderings and mutations.',
                  canonicalCode: `<${el.tag} v-for="item in items" :key="item.id">`,
                  referenceDoc: 'https://vuejs.org/guide/essentials/list.html#maintaining-state-with-key',
                })
              );
            } else if ((forDir as any).forParseResult?.key && keyDir.exp) {
              const loopIndexVar = (forDir as any).forParseResult.key.content?.trim();
              const keyExpr = (keyDir.exp as any).content?.trim();
              if (loopIndexVar && keyExpr === loopIndexVar) {
                const keyOffset = templateBlock.loc.start.offset + keyDir.loc.start.offset;
                const keyEnd = templateBlock.loc.start.offset + keyDir.loc.end.offset;
                diagnostics.push(
                  createDiagnostic({
                    ruleId: 'vue/require-v-for-key',
                    framework: 'vue',
                    category: 'performance',
                    severity: 'warning',
                    snapshot,
                    content,
                    startOffset: keyOffset,
                    endOffset: keyEnd,
                    smellTitle: `v-for uses array index '${loopIndexVar}' as :key`,
                    smellExplanation: `Using the array index as a key degrades diffing performance and causes state bugs when items are reordered, inserted, or removed.`,
                    canonSummary: `Use a unique item property (e.g. item.id) instead of array index.`,
                    canonRationale: 'Index keys change whenever array ordering changes, defeating the purpose of VDOM key identity tracking.',
                    canonicalCode: `:key="item.id"`,
                    referenceDoc: 'https://vuejs.org/guide/essentials/list.html#maintaining-state-with-key',
                  })
                );
              }
            }
          }

          // Rule: vue/no-prop-mutation in Template (v-model="props.xxx")
          for (const modelDir of modelDirs) {
            const expContent = (modelDir.exp as any)?.content?.trim();
            if (expContent && /^(?:\$?props)\./.test(expContent)) {
              const startOffset = templateBlock.loc.start.offset + modelDir.loc.start.offset;
              const endOffset = templateBlock.loc.start.offset + modelDir.loc.end.offset;
              diagnostics.push(
                createDiagnostic({
                  ruleId: 'vue/no-prop-mutation',
                  framework: 'vue',
                  category: 'data-flow',
                  severity: 'error',
                  snapshot,
                  content,
                  startOffset,
                  endOffset,
                  smellTitle: `Direct Vue Prop Mutation via v-model="${expContent}"`,
                  smellExplanation: `Directly binding 'v-model' to '${expContent}' violates Vue's one-way data flow. Child mutations will overwrite parent state without explicit notification.`,
                  canonSummary: `Use 'defineModel()' in Vue 3.4+ or emit an event update.`,
                  canonRationale: 'Vue enforces downward props and upward events. Two-way synchronization should be explicit via defineModel().',
                  canonicalCode: `// In script setup:\nconst modelValue = defineModel<string>();\n\n// In template:\nv-model="modelValue"`,
                  referenceDoc: 'https://vuejs.org/guide/components/v-model.html',
                })
              );
            }
          }

          for (const child of el.children) {
            walkTemplate(child);
          }
        }
      }

      for (const child of templateAst.children) {
        walkTemplate(child);
      }
    } catch {
      // Ignore template parse error here; source-map diagnostics will capture it
    }
  }

  // =========================================================================
  // 2. Script AST Checks (TypeScript AST)
  // =========================================================================
  const scriptBlocks = [parsed.scriptSetup, parsed.script].filter((b): b is NonNullable<typeof b> => Boolean(b));

  let hasModelValueProp = false;
  let hasUpdateModelValueEmit = false;
  let definePropsNode: ts.Node | null = null;
  const reactiveVariableNames = new Set<string>();

  for (const block of scriptBlocks) {
    const kind = /tsx/i.test(block.lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(snapshot.file, block.content, ts.ScriptTarget.Latest, true, kind);

    function visit(node: ts.Node) {
      // Check for reactive() variable assignments: const state = reactive(...)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        if (ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'reactive') {
          reactiveVariableNames.add(node.name.text);
        }
      }

      // Check: vue/no-reactive-destructure
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        // Direct: const { count } = reactive(...)
        const isDirectReactive = ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'reactive';

        // Variable: const { count } = state
        const isReactiveVar = ts.isIdentifier(node.initializer) && reactiveVariableNames.has(node.initializer.text);

        if (isDirectReactive || isReactiveVar) {
          const targetNode = node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent && ts.isVariableStatement(node.parent.parent)
            ? node.parent.parent
            : node;
          const startOffset = block.loc.start.offset + targetNode.getStart(sourceFile);
          const endOffset = block.loc.start.offset + targetNode.end;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'vue/no-reactive-destructure',
              framework: 'vue',
              category: 'reactivity',
              severity: 'warning',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: 'Destructuring reactive() Object Directly Loses Reactivity',
              smellExplanation: 'Destructuring properties from a reactive() object extracts primitive values without reactive proxy getters.',
              canonSummary: `Use 'toRefs()' to maintain reactivity when destructuring.`,
              canonRationale: 'toRefs() converts every property of a reactive object into an equivalent ref, preserving reactivity across destructuring.',
              canonicalCode: `import { toRefs } from 'vue';\nconst { ... } = toRefs(reactiveState);`,
              referenceDoc: 'https://vuejs.org/api/reactivity-utilities.html#torefs',
            })
          );
        }
      }

      // Check: vue/no-prop-mutation in Script
      if (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken ||
           node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken)) {
        if (ts.isPropertyAccessExpression(node.left)) {
          const propExpr = node.left.expression;
          if (ts.isIdentifier(propExpr) && (propExpr.text === 'props' || propExpr.text === '$props')) {
            const startOffset = block.loc.start.offset + node.getStart(sourceFile);
            const endOffset = block.loc.start.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'vue/no-prop-mutation',
                framework: 'vue',
                category: 'data-flow',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Direct Prop Mutation in Script: '${node.left.getText(sourceFile)}'`,
                smellExplanation: `Mutating prop '${node.left.name.text}' directly in script violates Vue's one-way data flow. The mutated value is local to this component and may be overwritten on parent re-render.`,
                canonSummary: `Emit an event to the parent component instead of mutating the prop directly.`,
                canonRationale: 'Components should treat incoming props as read-only snapshots and emit events upward for mutations.',
                canonicalCode: `emit('update:${node.left.name.text}', newValue);`,
                referenceDoc: 'https://vuejs.org/guide/components/props.html#one-way-data-flow',
              })
            );
          }
        }
      }

      // Unary expression prop mutation: props.count++ or props.count--
      if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        if (ts.isPropertyAccessExpression(node.operand)) {
          const propExpr = node.operand.expression;
          if (ts.isIdentifier(propExpr) && (propExpr.text === 'props' || propExpr.text === '$props')) {
            const startOffset = block.loc.start.offset + node.getStart(sourceFile);
            const endOffset = block.loc.start.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'vue/no-prop-mutation',
                framework: 'vue',
                category: 'data-flow',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Direct Prop Mutation via Unary '${node.getText(sourceFile)}'`,
                smellExplanation: `Incrementing/decrementing props directly in child script breaks Vue one-way data flow.`,
                canonSummary: `Emit an update event to the parent component.`,
                canonRationale: 'Props must not be mutated directly by child components.',
                canonicalCode: `emit('update:${node.operand.name.text}', props.${node.operand.name.text} + 1);`,
                referenceDoc: 'https://vuejs.org/guide/components/props.html#one-way-data-flow',
              })
            );
          }
        }
      }

      // Check: vue/props-destructure-version (Vue < 3.5 warning)
      if (isPreVue35 && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        if (ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'defineProps') {
          const targetNode = node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent && ts.isVariableStatement(node.parent.parent)
            ? node.parent.parent
            : node;
          const startOffset = block.loc.start.offset + targetNode.getStart(sourceFile);
          const endOffset = block.loc.start.offset + targetNode.end;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'vue/props-destructure-version',
              framework: 'vue',
              category: 'reactivity',
              severity: 'warning',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `defineProps() Destructuring Loses Reactivity in Vue < 3.5`,
              smellExplanation: `In Vue ${vueMajor}.${vueMinor}, destructuring defineProps() disconnects reactive updates. Reactive props destructure is only native in Vue >= 3.5.`,
              canonSummary: `Assign to 'const props = defineProps(...)' or upgrade to Vue 3.5+.`,
              canonRationale: 'Prior to Vue 3.5, destructuring extracts values at mount time without reactive subscriptions.',
              canonicalCode: `const props = defineProps<Props>();`,
              referenceDoc: 'https://blog.vuejs.org/posts/vue-3-5#reactive-props-destructure',
            })
          );
        }
      }

      // Check: vue/props-destructure-version (Vue >= 3.5 recommending native destructure over withDefaults)
      if (isVue35Plus && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withDefaults') {
        const startOffset = block.loc.start.offset + node.getStart(sourceFile);
        const endOffset = block.loc.start.offset + node.end;
        diagnostics.push(
          createDiagnostic({
            ruleId: 'vue/props-destructure-version',
            framework: 'vue',
            category: 'reactivity',
            severity: 'info',
            snapshot,
            content,
            startOffset,
            endOffset,
            smellTitle: `withDefaults() is Redundant in Vue >= 3.5`,
            smellExplanation: `In Vue 3.5+, native reactive props destructuring is the official standard. withDefaults() is verbose and unnecessary.`,
            canonSummary: `Use native reactive props destructuring default values.`,
            canonRationale: 'Native JS destructuring default values are cleaner, fully type-safe, and natively transformed by Vue 3.5+ compiler.',
            canonicalCode: `const { title = 'Default' } = defineProps<{ title?: string }>();`,
            referenceDoc: 'https://blog.vuejs.org/posts/vue-3-5#reactive-props-destructure',
          })
        );
      }

      // Check: vue/no-async-computed
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'computed') {
        const firstArg = node.arguments[0];
        let isAsync = false;
        if (firstArg && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))) {
          isAsync = Boolean(firstArg.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
        } else if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          const getProp = firstArg.properties.find(p => p.name?.getText(sourceFile) === 'get');
          if (getProp && (ts.isMethodDeclaration(getProp) || ts.isPropertyAssignment(getProp))) {
            const fn = ts.isPropertyAssignment(getProp) ? getProp.initializer : getProp;
            if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) {
              isAsync = Boolean(fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
            }
          }
        }

        if (isAsync) {
          const startOffset = block.loc.start.offset + node.getStart(sourceFile);
          const endOffset = block.loc.start.offset + node.end;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'vue/no-async-computed',
              framework: 'vue',
              category: 'reactivity',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: 'Async Function Inside computed() Anti-Pattern',
              smellExplanation: 'computed() must be synchronous and pure. An async computed returns a Promise rather than the resolved value and cannot track reactive dependencies after an await.',
              canonSummary: `Use VueUse 'useAsyncState()', a query composable, or watchEffect with local ref.`,
              canonRationale: 'Vue reactivity relies on synchronous execution to track getter dependencies.',
              canonicalCode: `const { state: data, isLoading } = useAsyncState(fetchData, initialValue);`,
              referenceDoc: 'https://vuejs.org/guide/essentials/computed.html#getters-should-be-side-effect-free',
            })
          );
        }
      }

      // Check: vue/computed-over-watch (watch assigning directly to single ref.value)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'watch') {
        const callbackArg = node.arguments[1];
        if (callbackArg && (ts.isArrowFunction(callbackArg) || ts.isFunctionExpression(callbackArg))) {
          let isSoleAssignment = false;
          if (ts.isBlock(callbackArg.body)) {
            if (callbackArg.body.statements.length === 1) {
              const stmt = callbackArg.body.statements[0];
              if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                isSoleAssignment = true;
              }
            }
          } else if (ts.isBinaryExpression(callbackArg.body) && callbackArg.body.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            isSoleAssignment = true;
          }

          if (isSoleAssignment) {
            const startOffset = block.loc.start.offset + node.getStart(sourceFile);
            const endOffset = block.loc.start.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'vue/computed-over-watch',
                framework: 'vue',
                category: 'data-flow',
                severity: 'warning',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: 'watch() Used to Derive State Instead of computed()',
                smellExplanation: 'Using watch() solely to synchronize derived state causes unnecessary component updates and violates declarative reactivity.',
                canonSummary: `Replace with a pure 'computed()' property.`,
                canonRationale: 'computed() is lazily evaluated and automatically cached, preventing cascading updates.',
                canonicalCode: `const derivedState = computed(() => transform(source.value));`,
                referenceDoc: 'https://vuejs.org/guide/essentials/computed.html',
              })
            );
          }
        }
      }

      // Gather info for vue/prefer-define-model
      if (isVue34Plus) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === 'defineProps') {
            definePropsNode = node;
            const text = node.getText(sourceFile);
            if (text.includes('modelValue')) hasModelValueProp = true;
          }
          if (node.expression.text === 'defineEmits') {
            const text = node.getText(sourceFile);
            if (text.includes('update:modelValue')) hasUpdateModelValueEmit = true;
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Rule: vue/prefer-define-model
  if (isVue34Plus && hasModelValueProp && hasUpdateModelValueEmit && definePropsNode) {
    const block = parsed.scriptSetup || parsed.script;
    if (block) {
      const startOffset = block.loc.start.offset + definePropsNode.pos;
      const endOffset = block.loc.start.offset + definePropsNode.end;
      diagnostics.push(
        createDiagnostic({
          ruleId: 'vue/prefer-define-model',
          framework: 'vue',
          category: 'legacy-syntax',
          severity: 'info',
          snapshot,
          content,
          startOffset,
          endOffset,
          smellTitle: 'Manual modelValue Props & update:modelValue Emit Boilerplate',
          smellExplanation: 'In Vue >= 3.4, defineModel() replaces the verbose combination of modelValue in defineProps and update:modelValue in defineEmits.',
          canonSummary: `Use 'const model = defineModel<string>()'.`,
          canonRationale: 'defineModel() simplifies two-way v-model binding down to a single reactive ref declaration.',
          canonicalCode: `const model = defineModel<string>();`,
          referenceDoc: 'https://vuejs.org/guide/components/v-model.html',
        })
      );
    }
  }

  return diagnostics;
}
