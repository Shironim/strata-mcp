import ts from 'typescript';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { parseSfc } from '../splitter';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

/**
 * Nuxt Canonical Pattern Rules:
 * 1. nuxt/no-raw-fetch-in-setup: Prohibits bare $fetch/fetch in root setup (causes SSR hydration double-fetch).
 * 2. nuxt/ssr-browser-api-leak: Prohibits unguarded browser globals (window, document, localStorage) in SSR setup.
 * 3. nuxt/no-singleton-ref-outside-setup: Prohibits singleton ref()/reactive() outside composable functions (SSR state pollution).
 * 4. nuxt/await-after-reactive-context: Flags calling Nuxt instance composables after an await in setup.
 * 5. nuxt/prefer-navigate-to: Recommends navigateTo() over window.location or router.push in Nuxt context.
 * 6. nuxt/use-fetch-reactive-watch: Recommends reactive getter function or query option when url contains .value.
 */
export async function checkNuxtRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];

  const isVueFile = snapshot.file.endsWith('.vue');
  const scriptBlocks: Array<{ code: string; offset: number; isSetup: boolean }> = [];

  if (isVueFile) {
    const parsed = parseSfc(content, snapshot.file);
    if (parsed.scriptSetup) {
      scriptBlocks.push({
        code: parsed.scriptSetup.content,
        offset: parsed.scriptSetup.loc.start.offset,
        isSetup: true,
      });
    }
    if (parsed.script) {
      scriptBlocks.push({
        code: parsed.script.content,
        offset: parsed.script.loc.start.offset,
        isSetup: false,
      });
    }
  } else {
    // Pure TypeScript / JavaScript composable or server route file
    scriptBlocks.push({
      code: content,
      offset: 0,
      isSetup: false,
    });
  }

  const NUXT_INSTANCE_COMPOSABLES = new Set([
    'useRoute',
    'useRouter',
    'useState',
    'useRuntimeConfig',
    'useNuxtApp',
    'useCookie',
    'useHead',
    'useSeoMeta',
  ]);

  const BROWSER_GLOBALS = new Set([
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'navigator',
  ]);

  const CLIENT_ONLY_HOOKS = new Set([
    'onMounted',
    'onBeforeMount',
    'onUnmounted',
    'onBeforeUnmount',
    'onActivated',
    'onDeactivated',
  ]);

  const SSR_EXECUTING_COMPOSABLES = new Set([
    'computed',
    'watch',
    'watchEffect',
    'watchSyncEffect',
    'watchPostEffect',
  ]);

  for (const block of scriptBlocks) {
    const sourceFile = ts.createSourceFile(snapshot.file, block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    let hasEncounteredAwait = false;

    // Helper: check if a node is enclosed within an onMounted() call, client lifecycle hook, or client guard
    function isInsideClientGuard(node: ts.Node): boolean {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        // Enclosed in client lifecycle hook: onMounted(() => ...)
        if (
          ts.isCallExpression(current) &&
          ts.isIdentifier(current.expression) &&
          CLIENT_ONLY_HOOKS.has(current.expression.text)
        ) {
          return true;
        }
        // Enclosed in if (import.meta.client || process.client)
        if (ts.isIfStatement(current)) {
          const condText = current.expression.getText(sourceFile);
          if (condText.includes('import.meta.client') || condText.includes('process.client')) {
            return true;
          }
        }
        // Enclosed in function or method declaration
        if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
          return true;
        }
        // Enclosed in arrow function or function expression
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
          // If the arrow function is an argument to an SSR-executing composable (e.g. computed(() => window.innerWidth)),
          // it executes during SSR and is NOT client-safe!
          const parent = current.parent;
          if (
            parent &&
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            SSR_EXECUTING_COMPOSABLES.has(parent.expression.text)
          ) {
            return false;
          }
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    function isInsideAnyFunction(node: ts.Node): boolean {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (
          ts.isFunctionDeclaration(current) ||
          ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    // Traverse top-level statements for setup-specific rules
    for (const statement of sourceFile.statements) {
      // Rule 1: nuxt/no-raw-fetch-in-setup
      // Detect top-level: const data = await $fetch(...) or await fetch(...)
      if (block.isSetup) {
        let isTopLevelFetch = false;
        let fetchCallName = '';
        let targetNode: ts.Node = statement;

        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            if (decl.initializer && ts.isAwaitExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
                if (expr.expression.text === '$fetch' || expr.expression.text === 'fetch') {
                  isTopLevelFetch = true;
                  fetchCallName = expr.expression.text;
                  targetNode = decl;
                  break;
                }
              }
            }
          }
        } else if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)) {
          const expr = statement.expression.expression;
          if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
            if (expr.expression.text === '$fetch' || expr.expression.text === 'fetch') {
              isTopLevelFetch = true;
              fetchCallName = expr.expression.text;
            }
          }
        }

        if (isTopLevelFetch) {
          const startOffset = block.offset + targetNode.getStart(sourceFile);
          const endOffset = block.offset + targetNode.end;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'nuxt/no-raw-fetch-in-setup',
              framework: 'nuxt',
              category: 'ssr-hydration',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `Bare 'await ${fetchCallName}()' in <script setup> Causes Double-Fetch`,
              smellExplanation: `Calling bare 'await ${fetchCallName}()' at the root of <script setup> executes once on the server during SSR and again in the browser during hydration, doubling network requests and causing state flashes.`,
              canonSummary: `Use 'await useFetch(...)' or 'useAsyncData(...)'.`,
              canonRationale: 'Nuxt useFetch() serializes server response data into the HTML payload so client hydration reuses it without re-fetching.',
              canonicalCode: `const { data } = await useFetch('/api/endpoint');`,
              referenceDoc: 'https://nuxt.com/docs/getting-started/data-fetching',
            })
          );
        }
      }

      // Rule 3: nuxt/no-singleton-ref-outside-setup
      // Detect top-level module ref() or reactive() declarations outside functions
      if (!block.isSetup) {
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            if (decl.initializer && ts.isCallExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
              const fnName = decl.initializer.expression.text;
              if (fnName === 'ref' || fnName === 'reactive' || fnName === 'shallowRef') {
                const varName = decl.name.getText(sourceFile);
                const startOffset = block.offset + statement.getStart(sourceFile);
                const endOffset = block.offset + statement.end;
                diagnostics.push(
                  createDiagnostic({
                    ruleId: 'nuxt/no-singleton-ref-outside-setup',
                    framework: 'nuxt',
                    category: 'ssr-hydration',
                    severity: 'error',
                    snapshot,
                    content,
                    startOffset,
                    endOffset,
                    smellTitle: `Global Module '${fnName}()' Outside Function Causes Cross-Request Pollution`,
                    smellExplanation: `Declaring '${varName} = ${fnName}()' at module scope creates a single state instance shared across all incoming HTTP requests on Node.js/Nitro servers, causing data leaks between users.`,
                    canonSummary: `Use 'useState("${varName}", () => initialValue)'.`,
                    canonRationale: 'Nuxt useState() scopes state per SSR request context and automatically dehydrates/hydrates across server and client boundaries.',
                    canonicalCode: `export const use${varName.charAt(0).toUpperCase() + varName.slice(1)} = () => {\n  return useState('${varName}', () => initialValue);\n};`,
                    referenceDoc: 'https://nuxt.com/docs/getting-started/state-management',
                  })
                );
              }
            }
          }
        }
      }

      // Check for top-level await in setup to track async boundary for Rule 4
      if (block.isSetup) {
        let stmtHasAwait = false;
        function checkAwait(n: ts.Node) {
          if (ts.isAwaitExpression(n)) stmtHasAwait = true;
          if (!stmtHasAwait) ts.forEachChild(n, checkAwait);
        }
        checkAwait(statement);
        if (stmtHasAwait) {
          hasEncounteredAwait = true;
        }
      }

      // Deep statement visit for Rules 2, 4, 5, 6
      function visitNode(node: ts.Node) {
        // Rule 2: nuxt/ssr-browser-api-leak
        // Accessing window.*, document.*, localStorage.* without onMounted or client guard
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const globalObj = node.expression.text;
          if (BROWSER_GLOBALS.has(globalObj) && !isInsideClientGuard(node)) {
            const startOffset = block.offset + node.getStart(sourceFile);
            const endOffset = block.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'nuxt/ssr-browser-api-leak',
                framework: 'nuxt',
                category: 'ssr-hydration',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Unguarded Browser Global '${globalObj}' in SSR Context`,
                smellExplanation: `'${globalObj}' is undefined on the server during Nuxt SSR rendering. Accessing it directly outside onMounted() or import.meta.client will crash with ReferenceError.`,
                canonSummary: `Wrap with onMounted(() => ...) or check 'if (import.meta.client)'.`,
                canonRationale: 'SSR lifecycle runs server-side first; browser DOM and storage APIs only exist after client mount.',
                canonicalCode: `onMounted(() => {\n  ${node.getText(sourceFile)};\n});`,
                referenceDoc: 'https://nuxt.com/docs/guide/concepts/server-engine#ssr-caveats',
              })
            );
          }
        }

        // Rule 4: nuxt/await-after-reactive-context
        // Calling useRoute(), useState() etc. after an await in top-level setup execution
        if (
          block.isSetup &&
          hasEncounteredAwait &&
          !isInsideAnyFunction(node) &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression)
        ) {
          const calledFn = node.expression.text;
          if (NUXT_INSTANCE_COMPOSABLES.has(calledFn)) {
            const startOffset = block.offset + node.getStart(sourceFile);
            const endOffset = block.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'nuxt/await-after-reactive-context',
                framework: 'nuxt',
                category: 'reactivity',
                severity: 'error',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Nuxt Composable '${calledFn}()' Called After 'await'`,
                smellExplanation: `Calling '${calledFn}()' after an await statement loses the current NuxtApp instance context and will crash with 'Nuxt instance unavailable'.`,
                canonSummary: `Call '${calledFn}()' at the top of setup before any await statements.`,
                canonRationale: 'Vue setup and Nuxt instance binding relies on synchronous execution ticks. Await pauses execution and detaches the current instance.',
                canonicalCode: `const ${calledFn.replace(/^use/, '').toLowerCase()} = ${calledFn}();\n// then call await\nawait somethingAsync();`,
                referenceDoc: 'https://nuxt.com/docs/guide/going-further/custom-composables',
              })
            );
          }
        }

        // Rule 5: nuxt/prefer-navigate-to
        // window.location = ... or window.location.href = ... or location.assign(...) or location.replace(...)
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const leftText = node.left.getText(sourceFile);
          if (
            leftText === 'window.location.href' ||
            leftText === 'location.href' ||
            leftText === 'window.location' ||
            leftText === 'location'
          ) {
            const startOffset = block.offset + node.getStart(sourceFile);
            const endOffset = block.offset + node.end;
            diagnostics.push(
              createDiagnostic({
                ruleId: 'nuxt/prefer-navigate-to',
                framework: 'nuxt',
                category: 'boundary',
                severity: 'warning',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Hard Reload Navigation via '${leftText}'`,
                smellExplanation: `Using '${leftText}' causes a full page reload and destroys SPA state.`,
                canonSummary: `Use Nuxt canonical 'return navigateTo(...)'.`,
                canonRationale: 'navigateTo() works universally on both server (performing SSR 302 redirect) and client (SPA navigation).',
                canonicalCode: `return navigateTo(${node.right.getText(sourceFile)});`,
                referenceDoc: 'https://nuxt.com/docs/api/utils/navigate-to',
              })
            );
          }
        } else if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          const propExpr = node.expression;
          const callerText = propExpr.expression.getText(sourceFile);
          const method = propExpr.name.text;
          if (
            (callerText === 'window.location' || callerText === 'location') &&
            (method === 'assign' || method === 'replace')
          ) {
            const startOffset = block.offset + node.getStart(sourceFile);
            const endOffset = block.offset + node.end;
            const targetArg = node.arguments[0] ? node.arguments[0].getText(sourceFile) : "''";
            diagnostics.push(
              createDiagnostic({
                ruleId: 'nuxt/prefer-navigate-to',
                framework: 'nuxt',
                category: 'boundary',
                severity: 'warning',
                snapshot,
                content,
                startOffset,
                endOffset,
                smellTitle: `Hard Reload Navigation via '${callerText}.${method}()'`,
                smellExplanation: `Using '${callerText}.${method}()' causes a full page reload and destroys SPA state.`,
                canonSummary: `Use Nuxt canonical 'return navigateTo(...)'.`,
                canonRationale: 'navigateTo() works universally on both server (performing SSR 302 redirect) and client (SPA navigation).',
                canonicalCode: `return navigateTo(${targetArg});`,
                referenceDoc: 'https://nuxt.com/docs/api/utils/navigate-to',
              })
            );
          }
        }

        // Rule 6: nuxt/use-fetch-reactive-watch
        // useFetch(`/api/items?page=${page.value}`) or useFetch('/api/items?page=' + page.value)
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === 'useFetch' || node.expression.text === 'useLazyFetch') {
            const firstArg = node.arguments[0];
            if (firstArg) {
              const isTemplate = ts.isTemplateExpression(firstArg);
              const isBinaryConcat =
                ts.isBinaryExpression(firstArg) && firstArg.operatorToken.kind === ts.SyntaxKind.PlusToken;
              if (isTemplate || isBinaryConcat) {
                const argText = firstArg.getText(sourceFile);
                if (/\b[A-Za-z0-9_$]+\.value\b/.test(argText)) {
                  const startOffset = block.offset + node.getStart(sourceFile);
                  const endOffset = block.offset + node.end;
                  diagnostics.push(
                    createDiagnostic({
                      ruleId: 'nuxt/use-fetch-reactive-watch',
                      framework: 'nuxt',
                      category: 'reactivity',
                      severity: 'warning',
                      snapshot,
                      content,
                      startOffset,
                      endOffset,
                      smellTitle: `Static Evaluation of '.value' in ${node.expression.text}() Argument`,
                      smellExplanation: `Evaluating '.value' directly inside ${isTemplate ? 'a template string' : 'a string concatenation'} runs only once at setup; changes to the ref will NOT trigger automatic re-fetching.`,
                      canonSummary: `Use a getter function or pass the query option: query: { page }.`,
                      canonRationale: 'useFetch watches URL getter functions or reactive query params automatically.',
                      canonicalCode: `useFetch(() => ${argText});\n// or\nuseFetch('/api/items', { query: { ... } });`,
                      referenceDoc: 'https://nuxt.com/docs/getting-started/data-fetching#watch',
                    })
                  );
                }
              }
            }
          }
        }

        ts.forEachChild(node, visitNode);
      }

      visitNode(statement);
    }
  }

  return diagnostics;
}
