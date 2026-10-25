import ts from 'typescript';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { getProjectEcosystem } from '../framework-detector';
import { findProjectRoot } from '../path-resolver';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

function returnsJsx(node: ts.Node): boolean {
  let found = false;
  function visit(child: ts.Node) {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function hasReturnStatement(node: ts.Node): boolean {
  let found = false;
  function visit(child: ts.Node) {
    if (found) return;
    if (ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function containsHookCall(node: ts.Node): ts.CallExpression | null {
  let hookCall: ts.CallExpression | null = null;
  function visit(child: ts.Node) {
    if (hookCall) return;
    if (ts.isCallExpression(child)) {
      let name = '';
      if (ts.isIdentifier(child.expression)) name = child.expression.text;
      else if (ts.isPropertyAccessExpression(child.expression)) name = child.expression.name.text;
      if (/^use[A-Z]/.test(name) || name === 'use') {
        hookCall = child;
        return;
      }
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return hookCall;
}

export async function checkReactRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions & { frameworkVersion?: string }
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];
  const sf = ts.createSourceFile(snapshot.file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Check react version for React 19 rules
  let isReact19 = false;
  if (options?.frameworkVersion && /^19\b/.test(options.frameworkVersion)) {
    isReact19 = true;
  } else {
    try {
      const rootDir = findProjectRoot(snapshot.file);
      const eco = getProjectEcosystem(rootDir);
      if (eco.frameworks.react?.major && eco.frameworks.react.major >= 19) {
        isReact19 = true;
      }
    } catch {
      // ignore
    }
  }

  // Traverse file AST
  function visitTopLevel(node: ts.Node): void {
    // 1. React 19: forwardRef deprecated
    if (isReact19 && ts.isCallExpression(node)) {
      let isForwardRef = false;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'forwardRef') {
        isForwardRef = true;
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'React' && node.expression.name.text === 'forwardRef') {
          isForwardRef = true;
        }
      }
      if (isForwardRef) {
        diagnostics.push(
          createDiagnostic({
            ruleId: 'react/react19-forward-ref-deprecated',
            framework: 'react',
            category: 'architecture',
            severity: 'warning',
            snapshot,
            content,
            startOffset: node.getStart(sf),
            endOffset: node.end,
            smellTitle: 'Deprecated forwardRef in React 19',
            smellExplanation: 'In React 19, ref can now be passed directly as a standard component prop without the forwardRef wrapper.',
            canonSummary: 'Remove forwardRef wrapper and receive ref as a regular prop.',
            canonRationale: 'React 19 treats ref as a standard prop, making forwardRef obsolete and simplifying component signatures.',
            canonicalCode: `function Button({ children, ref }: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {\n  return <button ref={ref}>{children}</button>;\n}`,
            referenceDoc: 'https://react.dev/blog/2024/04/25/react-19#ref-as-a-prop',
          })
        );
      }
    }

    // Check components
    let isComponent = false;
    let componentBody: ts.Block | ts.ConciseBody | undefined;
    let componentName: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && returnsJsx(node)) {
      isComponent = true;
      componentBody = node.body;
      componentName = node.name.text;
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text) && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            if (returnsJsx(decl.initializer)) {
              isComponent = true;
              componentBody = decl.initializer.body;
              componentName = decl.name.text;
              checkComponentBody(decl.initializer.body, snapshot, content, sf, diagnostics);
            }
          }
        }
      }
    }

    if (isComponent && componentBody) {
      checkComponentBody(componentBody, snapshot, content, sf, diagnostics);
    }

    // Check array index keys & inline functions in map loops
    checkMapLoops(node, snapshot, content, sf, diagnostics);

    ts.forEachChild(node, visitTopLevel);
  }

  visitTopLevel(sf);
  return diagnostics;
}

function checkComponentBody(
  body: ts.Node,
  snapshot: SourceSnapshot,
  content: string,
  sf: ts.SourceFile,
  diagnostics: CodePatternDiagnostic[]
): void {
  const stateVars = new Set<string>();
  const stateSetters = new Map<string, string>(); // setterName -> stateVar

  // 1. First pass: Collect useState variables and setters
  function collectState(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      let isUseState = false;
      if (ts.isIdentifier(call.expression) && call.expression.text === 'useState') isUseState = true;
      else if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'useState') isUseState = true;

      if (isUseState && ts.isArrayBindingPattern(node.name)) {
        const elements = node.name.elements;
        const stateIdent = elements[0] && ts.isBindingElement(elements[0]) && ts.isIdentifier(elements[0].name) ? elements[0].name.text : undefined;
        const setterIdent = elements[1] && ts.isBindingElement(elements[1]) && ts.isIdentifier(elements[1].name) ? elements[1].name.text : undefined;
        if (stateIdent) stateVars.add(stateIdent);
        if (setterIdent && stateIdent) stateSetters.set(setterIdent, stateIdent);
      }
    }
    ts.forEachChild(node, collectState);
  }
  collectState(body);

  // 2. Second pass: Detect Rule Violations
  let seenEarlyReturn = false;

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      // Check conditional early return
      if (ts.isIfStatement(stmt)) {
        if (hasReturnStatement(stmt.thenStatement) || (stmt.elseStatement && hasReturnStatement(stmt.elseStatement))) {
          seenEarlyReturn = true;
        }
      } else if (seenEarlyReturn) {
        const hook = containsHookCall(stmt);
        if (hook) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'react/rules-of-hooks-conditional',
              framework: 'react',
              category: 'architecture',
              severity: 'error',
              snapshot,
              content,
              startOffset: hook.getStart(sf),
              endOffset: hook.end,
              smellTitle: 'Hook Called Conditionally or After Early Return',
              smellExplanation: 'Calling hooks conditionally or after early return breaks the Rules of Hooks. React relies on identical hook execution order on every render.',
              canonSummary: 'Move all hook invocations to the top level of the component before any early returns.',
              canonRationale: 'Consistent hook execution order preserves React internal fiber state linked-list.',
              canonicalCode: `// Hooks at top of component:\nconst [data, setData] = useState(null);\n// Early return after hooks:\nif (loading) return <Spinner />;`,
              referenceDoc: 'https://react.dev/reference/rules/rules-of-hooks',
            })
          );
        }
      }
    }
  }

  function inspectNode(node: ts.Node, inConditional: boolean) {
    // A. Conditional Hook calls (inside if, loop, switch)
    const isControlFlow = ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node);
    const currentlyInConditional = inConditional || isControlFlow;

    if (currentlyInConditional && ts.isCallExpression(node)) {
      let isHook = false;
      let hookName = '';
      if (ts.isIdentifier(node.expression)) {
        hookName = node.expression.text;
        isHook = /^use[A-Z]/.test(hookName);
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        hookName = node.expression.name.text;
        isHook = /^use[A-Z]/.test(hookName);
      }
      if (isHook) {
        diagnostics.push(
          createDiagnostic({
            ruleId: 'react/rules-of-hooks-conditional',
            framework: 'react',
            category: 'architecture',
            severity: 'error',
            snapshot,
            content,
            startOffset: node.getStart(sf),
            endOffset: node.end,
            smellTitle: 'Hook Called Inside Conditional or Loop',
            smellExplanation: `Hook '${hookName}' is called inside an if, loop, or switch block. Hooks must only be called unconditionally at the top level.`,
            canonSummary: 'Move hook call outside the conditional block to the top level of the component.',
            canonRationale: 'React hooks rely on identical call orders across renders.',
            canonicalCode: `// Move to top level unconditionally:\nconst [active, setActive] = useState(false);`,
            referenceDoc: 'https://react.dev/reference/rules/rules-of-hooks',
          })
        );
      }
    }

    // B. react/no-unstable-nested-component
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && returnsJsx(node)) {
      diagnostics.push(
        createDiagnostic({
          ruleId: 'react/no-unstable-nested-component',
          framework: 'react',
          category: 'architecture',
          severity: 'error',
          snapshot,
          content,
          startOffset: node.getStart(sf),
          endOffset: node.end,
          smellTitle: 'Unstable Nested Component Declaration',
          smellExplanation: `Declaring component '${node.name.text}' inside another component body creates a new component reference on every parent render, unmounting its DOM subtree and losing internal state.`,
          canonSummary: 'Move nested component declaration outside the parent component to module scope.',
          canonRationale: 'Module-level component declarations preserve component identity and DOM state across re-renders.',
          canonicalCode: `// Move outside parent component:\nfunction ${node.name.text}(props) {\n  return <div />;\n}`,
          referenceDoc: 'https://react.dev/learn/your-first-component#nesting-and-organizing-components',
        })
      );
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text) && decl.initializer) {
          if ((ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && returnsJsx(decl.initializer)) {
            diagnostics.push(
              createDiagnostic({
                ruleId: 'react/no-unstable-nested-component',
                framework: 'react',
                category: 'architecture',
                severity: 'error',
                snapshot,
                content,
                startOffset: node.getStart(sf),
                endOffset: node.end,
                smellTitle: 'Unstable Nested Component Declaration',
                smellExplanation: `Declaring component '${decl.name.text}' inside another component body creates a new component reference on every parent render, unmounting its DOM subtree and losing internal state.`,
                canonSummary: 'Move nested component declaration outside the parent component to module scope.',
                canonRationale: 'Module-level component declarations preserve component identity and DOM state across re-renders.',
                canonicalCode: `// Move outside parent component:\nconst ${decl.name.text} = (props) => {\n  return <div />;\n};`,
                referenceDoc: 'https://react.dev/learn/your-first-component#nesting-and-organizing-components',
              })
            );
          }
        }
      }
    }

    // C. react/no-direct-state-mutation
    // Check direct mutation: props.xxx = ..., props.xxx++, stateVar.push(...), etc.
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(node.operatorToken.kind)) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const objText = node.left.expression.getText(sf);
        if (objText === 'props' || objText === '$props' || stateVars.has(objText)) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'react/no-direct-state-mutation',
              framework: 'react',
              category: 'correctness',
              severity: 'error',
              snapshot,
              content,
              startOffset: node.getStart(sf),
              endOffset: node.end,
              smellTitle: 'Direct Mutation of State or Props',
              smellExplanation: `Directly mutating '${node.left.getText(sf)}' bypasses React's change detection and breaks unidirectional data flow.`,
              canonSummary: 'Treat state and props as immutable. Use setState with a new immutable copy.',
              canonRationale: 'React uses Object.is shallow comparison to detect state changes and schedule renders.',
              canonicalCode: `// For state updates:\nsetState(prev => ({ ...prev, ${node.left.name.text}: value }));`,
              referenceDoc: 'https://react.dev/learn/updating-objects-in-state',
            })
          );
        }
      } else if (ts.isElementAccessExpression(node.left)) {
        const objText = node.left.expression.getText(sf);
        if (stateVars.has(objText)) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'react/no-direct-state-mutation',
              framework: 'react',
              category: 'correctness',
              severity: 'error',
              snapshot,
              content,
              startOffset: node.getStart(sf),
              endOffset: node.end,
              smellTitle: 'Direct Array State Mutation',
              smellExplanation: `Directly mutating index on state array '${objText}' bypasses React change detection.`,
              canonSummary: 'Use immutable array operations (map, filter, or spread).',
              canonRationale: 'React requires new array reference to trigger component re-render.',
              canonicalCode: `setItems(prev => prev.map((item, idx) => idx === index ? updated : item));`,
              referenceDoc: 'https://react.dev/learn/updating-arrays-in-state',
            })
          );
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const objText = node.expression.expression.getText(sf);
      const method = node.expression.name.text;
      const mutatingArrayMethods = new Set(['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse']);
      if ((stateVars.has(objText) || objText === 'props' || objText === '$props') && mutatingArrayMethods.has(method)) {
        diagnostics.push(
          createDiagnostic({
            ruleId: 'react/no-direct-state-mutation',
            framework: 'react',
            category: 'correctness',
            severity: 'error',
            snapshot,
            content,
            startOffset: node.getStart(sf),
            endOffset: node.end,
            smellTitle: `Mutating Method '${method}' Called on State/Props`,
            smellExplanation: `Calling mutating method '.${method}()' on state '${objText}' modifies array in-place without triggering re-render.`,
            canonSummary: 'Create a new copy of the array using spread or immutable array methods.',
            canonRationale: 'Mutating array in-place preserves old reference, causing React to miss the update.',
            canonicalCode: `set${objText.charAt(0).toUpperCase() + objText.slice(1)}(prev => [...prev, newItem]);`,
            referenceDoc: 'https://react.dev/learn/updating-arrays-in-state',
          })
        );
      }
    }

    // D. react/no-derived-state-in-effect & react/effect-missing-cleanup-or-abort
    if (ts.isCallExpression(node)) {
      let isEffect = false;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') isEffect = true;
      else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'useEffect') isEffect = true;

      if (isEffect && node.arguments.length > 0) {
        const effectCallback = node.arguments[0];
        const effectBody = ts.isArrowFunction(effectCallback) || ts.isFunctionExpression(effectCallback) ? effectCallback.body : undefined;

        if (effectBody) {
          const callbackCode = effectBody.getText(sf);
          const hasAsyncOperations =
            /fetch\s*\(|axios\b|\bsetTimeout\b|\bsetInterval\b|\baddEventListener\b|\bsubscribe\b|\bawait\b|\.then\s*\(|XMLHttpRequest/i.test(
              callbackCode
            );

          // Check if effect calls any state setter synchronously
          for (const [setterName, stateName] of stateSetters.entries()) {
            const setterCallRegex = new RegExp(`\\b${setterName}\\s*\\(`);
            if (setterCallRegex.test(callbackCode) && !hasAsyncOperations) {
              diagnostics.push(
                createDiagnostic({
                  ruleId: 'react/no-derived-state-in-effect',
                  framework: 'react',
                  category: 'architecture',
                  severity: 'warning',
                  snapshot,
                  content,
                  startOffset: node.getStart(sf),
                  endOffset: node.end,
                  smellTitle: 'Derived State Synchronized in useEffect',
                  smellExplanation: `Updating state '${stateName}' via '${setterName}()' inside useEffect to sync derived data causes redundant re-renders and UI flashes ("You Might Not Need an Effect").`,
                  canonSummary: 'Calculate derived state directly during render or use useMemo for expensive computations.',
                  canonRationale: 'In-render calculations execute synchronously without causing a second render pass.',
                  canonicalCode: `// Calculate directly in render:\nconst ${stateName} = computeValue(depA, depB);`,
                  referenceDoc: 'https://react.dev/learn/you-might-not-need-an-effect',
                })
              );
              break;
            }
          }

          // Check async fetch missing cleanup/abort
          const hasFetch = /fetch\s*\(|axios\.(?:get|post|put|delete|patch)|api\.(?:get|post)/.test(callbackCode);
          if (hasFetch) {
            const hasAbort = /AbortController/.test(callbackCode);
            const hasCleanupReturn = hasReturnStatement(effectBody);
            if (!hasAbort && !hasCleanupReturn) {
              diagnostics.push(
                createDiagnostic({
                  ruleId: 'react/effect-missing-cleanup-or-abort',
                  framework: 'react',
                  category: 'reliability',
                  severity: 'warning',
                  snapshot,
                  content,
                  startOffset: node.getStart(sf),
                  endOffset: node.end,
                  smellTitle: 'Async Effect Missing Cleanup or AbortController',
                  smellExplanation: 'Async data fetching in useEffect without an AbortController or cleanup function is vulnerable to race conditions if props/state change before the network request resolves.',
                  canonSummary: 'Add an AbortController to cancel pending requests on cleanup, or use a data-fetching library (TanStack Query / SWR).',
                  canonRationale: 'Cleanup functions prevent out-of-order response overwriting and memory leaks when components unmount.',
                  canonicalCode: `useEffect(() => {\n  const controller = new AbortController();\n  fetch(url, { signal: controller.signal })\n    .then(res => res.json())\n    .then(data => setData(data))\n    .catch(err => { if (err.name !== 'AbortError') setError(err); });\n  return () => controller.abort();\n}, [url]);`,
                  referenceDoc: 'https://react.dev/learn/synchronizing-with-effects#fetching-data',
                })
              );
            }
          }
        }
      }
    }

    ts.forEachChild(node, child => inspectNode(child, currentlyInConditional));
  }

  inspectNode(body, false);
}

function checkMapLoops(
  node: ts.Node,
  snapshot: SourceSnapshot,
  content: string,
  sf: ts.SourceFile,
  diagnostics: CodePatternDiagnostic[]
): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
    if (node.arguments.length > 0) {
      const mapCallback = node.arguments[0];
      if (ts.isArrowFunction(mapCallback) || ts.isFunctionExpression(mapCallback)) {
        let indexParamName: string | undefined;
        if (mapCallback.parameters.length >= 2) {
          const indexParam = mapCallback.parameters[1];
          if (ts.isIdentifier(indexParam.name)) {
            indexParamName = indexParam.name.text;
          }
        }

        function inspectJsx(child: ts.Node) {
          if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
            const attributes = ts.isJsxElement(child) ? child.openingElement.attributes : child.attributes;
            for (const prop of attributes.properties) {
              if (ts.isJsxAttribute(prop) && prop.name && ts.isIdentifier(prop.name)) {
                const attrName = prop.name.text;

                // 1. react/no-array-index-key
                if (attrName === 'key' && indexParamName && prop.initializer && ts.isJsxExpression(prop.initializer)) {
                  const expr = prop.initializer.expression;
                  if (expr && ts.isIdentifier(expr) && expr.text === indexParamName) {
                    diagnostics.push(
                      createDiagnostic({
                        ruleId: 'react/no-array-index-key',
                        framework: 'react',
                        category: 'correctness',
                        severity: 'warning',
                        snapshot,
                        content,
                        startOffset: prop.getStart(sf),
                        endOffset: prop.end,
                        smellTitle: 'Array Index Used as JSX Key',
                        smellExplanation: `Using array index '${indexParamName}' as key inside .map() can break component state and reconciliation when items are reordered, inserted, or deleted.`,
                        canonSummary: 'Use a unique, stable identifier from the item data for the key attribute.',
                        canonRationale: 'Keys allow React to identify which items have changed, been added, or been removed.',
                        canonicalCode: `{items.map(item => <Row key={item.id} item={item} />)}`,
                        referenceDoc: 'https://react.dev/learn/rendering-lists#where-to-get-your-key',
                      })
                    );
                  }
                }

                // 2. react/no-inline-function-in-loop
                if (/^on[A-Z]/.test(attrName) && prop.initializer && ts.isJsxExpression(prop.initializer)) {
                  const expr = prop.initializer.expression;
                  if (expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))) {
                    diagnostics.push(
                      createDiagnostic({
                        ruleId: 'react/no-inline-function-in-loop',
                        framework: 'react',
                        category: 'performance',
                        severity: 'warning',
                        snapshot,
                        content,
                        startOffset: prop.getStart(sf),
                        endOffset: prop.end,
                        smellTitle: 'Inline Function Allocation in Render Loop',
                        smellExplanation: `Creating inline closures for '${attrName}' inside .map() loops forces memory allocations on every component render and causes memoized child components to re-render.`,
                        canonSummary: 'Extract item renderer to a memoized child component or use a data-attribute handler.',
                        canonRationale: 'Stable function references preserve React shallow equality checks.',
                        canonicalCode: `const ListItem = React.memo(({ item, onSelect }: ItemProps) => (\n  <button onClick={() => onSelect(item.id)}>{item.name}</button>\n));`,
                        referenceDoc: 'https://react.dev/learn/rendering-lists',
                      })
                    );
                  }
                }
              }
            }
          }
          ts.forEachChild(child, inspectJsx);
        }

        inspectJsx(mapCallback.body);
      }
    }
  }
}
