import { parseTypeScript } from '../source-parser';
import type {
  DataDependencyInfo,
  StateAccessMode,
  StateDependencyInfo,
  StateDependencyItem,
} from '../../types';
import { COMMON_HOOKS_IGNORE } from './hook-names';
import { escapeRegExp } from '../patterns';
import ts from 'typescript';
import type { FrontendFramework } from '../../types';
import { createDocumentAdapter } from '../../adapters/factory';
import { extractTemplateExpressions, type TemplateExpression } from '../template';
import { extractReactStateDependencies } from './react-state-dependency';
import { reactBindings } from './react-bindings';
import { unwrapExpression } from './ts-syntax';

const PURE_GETTER = /^(?:(?:get|is|has|can|should|will|check|validate|format|parse|compute|map|to|use)(?:[A-Z_$]|$)|t$|_)/;

export function extractStateDependencies(
  content: string,
  _framework: FrontendFramework | 'vue-composable' | string,
  selfComponentName?: string
): StateDependencyInfo {
  if (_framework === 'react' || _framework === 'next') return extractReactStateDependencies(content, selfComponentName);
  const stores = new Set<string>();
  const contexts = new Set<string>();
  const composables = new Set<string>();

  const markup = /^\s*<(?:template|script)\b/.test(content);
  const astro = /^\s*---/.test(content);
  const leading = astro ? content.length - content.trimStart().length : 0;
  const adapter = createDocumentAdapter(
    astro ? 'file.astro' : _framework === 'svelte' ? 'file.svelte' : markup ? 'file.vue' : 'file.tsx',
    content.slice(leading)
  );
  const blocks: Array<{ code: string; offset: number; expression?: TemplateExpression; templateLine?: number; scriptSetup?: boolean }> =
    adapter.getScriptBlocks().map(b => ({ code: b.content, offset: leading + b.loc.start.offset, scriptSetup: b.type === 'scriptSetup' }));
  if (astro && !blocks.length) {
    const match = content.match(/^\s*---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*---/);
    if (match) blocks.push({ code: match[1], offset: content.indexOf(match[1], leading + 3) });
  }
  const template = adapter.getTemplateBlock();
  const templateBindings = new Map<number, Array<{ expression: string; directive?: string }>>();
  if (template && adapter.type === 'vue') {
    const starts = [0];
    for (let i = 0; i < template.content.length; i++) if (template.content[i] === '\n') starts.push(i + 1);
    const firstLine = content.slice(0, leading + template.loc.start.offset).split('\n').length;
    for (const exp of extractTemplateExpressions(template.content)) {
      const offset = starts[exp.start.line - 1] + exp.start.column - 1;
      blocks.push({ code: exp.content, offset: leading + template.loc.start.offset + offset, expression: exp, templateLine: firstLine + exp.start.line - 1 });
    }
  }
  const declaredDefinitions = new Set<string>();
  const aliases = new Map<string, string>();
  const storeRegex = /^use[A-Za-z0-9_$]*Store$/;
  const reduxRegex = /^(useSelector|useDispatch|useAppSelector|useAppDispatch)$/;
  const hookRegex = /^use[A-Z][A-Za-z0-9_$]*$/;
  const keyedTemplateRefs = new Map<string, string>();
  const keyedObservations: StateDependencyItem[] = [];
  const observedKeys = new Set<string>();
  const sourceLines = content.split('\n');
  const parsed = blocks.map(b => ({ ...b, sf: parseTypeScript('file.tsx', b.code, ts.ScriptKind.TSX) }));
  function declarations(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name)) declaredDefinitions.add(node.name.text);
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) if (!el.isTypeOnly) aliases.set(el.name.text, el.propertyName?.text ?? el.name.text);
      if (ts.isStringLiteral(node.moduleSpecifier) && /^@inertiajs\/(vue3|react|svelte|core)$/.test(node.moduleSpecifier.text)) {
        for (const el of node.importClause.namedBindings.elements) if (!el.isTypeOnly && (el.propertyName?.text ?? el.name.text) === 'router') composables.add(el.name.text);
      }
    }
    ts.forEachChild(node, declarations);
  }
  parsed.forEach(b => declarations(b.sf));
  function classify(local: string): void {
    const name = aliases.get(local) ?? local;
    if (local === selfComponentName || declaredDefinitions.has(local)) return;
    if (reduxRegex.test(name)) stores.add(local);
    else if (name !== 'useStore' && storeRegex.test(name)) stores.add(local);
    else if (hookRegex.test(name) && name !== 'useContext' && name !== 'useStore' && !COMMON_HOOKS_IGNORE.has(name)) composables.add(local);
  }
  // Keep coordinates, but remove non-executable text before access-mode classification.
  const executable = content.replace(/[^\r\n]/g, ' ').split('');
  for (const block of parsed) {
    const { sf, code, offset, expression, templateLine, scriptSetup } = block;
    const inspectKeyedRefs = _framework === 'nuxt' && (expression ? keyedTemplateRefs.size > 0 : code.includes('useState'));
    const bindings = inspectKeyedRefs ? reactBindings(sf) : undefined;
    const keyedScriptRefs = new Map<ts.Node, string>();
    const blockLine = inspectKeyedRefs ? templateLine ?? content.slice(0, offset).split('\n').length : 0;
    function recordKey(identifier: string, node: ts.Node, accessMode: StateAccessMode, property?: string): void {
      const lineNumber = blockLine + sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      keyedObservations.push({ kind: 'store', identifier, accessMode, lineNumber,
        usageSnippet: sourceLines[lineNumber - 1].trim().slice(0, 80),
        ...(property ? { accessedProperties: [property] } : {}) });
    }
    const masked = code.split('');
    const mask = (start: number, end: number) => { for (let i = start; i < end; i++) if (masked[i] !== '\n' && masked[i] !== '\r') masked[i] = ' '; };
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, code);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) mask(scanner.getTokenPos(), scanner.getTextPos());
    }
    function visit(node: ts.Node): void {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isImportSpecifier(node) && node.isTypeOnly)) { mask(node.getStart(sf), node.end); return; }
      if (ts.isImportSpecifier(node)) classify(node.name.text);
      if (ts.isIdentifier(node) && expression?.loopBindings?.has(node.text)) {
        const parent = node.parent;
        const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node;
        if (!propertyName) mask(node.getStart(sf), node.end);
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && !expression?.loopBindings?.has(node.expression.text)) {
          const local = node.expression.text;
          const name = aliases.get(local) ?? local;
          const arg = node.arguments[0];
          if (name === 'useStore' && arg && ts.isIdentifier(arg)) stores.add(arg.text);
          else if (name === 'useState' && arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg))) {
            const callee = bindings?.binding(node.expression);
            const isNuxtState = !callee || !callee.typeOnly && !!callee.source && /^(?:#imports$|#app(?:\/|$)|nuxt\/app(?:\/|$))/.test(callee.source);
            if (_framework !== 'nuxt' || isNuxtState) {
              stores.add(arg.text);
              if (ts.isStringLiteralLike(arg)) {
                composables.add(local);
                if (bindings && !expression) {
                  observedKeys.add(arg.text);
                  recordKey(arg.text, node, 'read');
                  let initializer: ts.Node = node;
                  while (ts.isExpression(initializer.parent) && unwrapExpression(initializer.parent) === node) initializer = initializer.parent;
                  const declaration = initializer.parent;
                  if (ts.isVariableDeclaration(declaration) && declaration.initializer === initializer && ts.isIdentifier(declaration.name)) {
                    keyedScriptRefs.set(declaration, arg.text);
                    if (scriptSetup && declaration.parent.parent.parent === sf) keyedTemplateRefs.set(declaration.name.text, arg.text);
                  }
                }
              }
            }
          }
          else if ((name === 'useContext' || name === 'inject' || name === 'getContext' || name === 'setContext') && arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg))) contexts.add(arg.text);
          else if (name === 'use' && arg && (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg))) {
            const argText = arg.getText(sf);
            if (/Context$/.test(argText) || /^[A-Z]/.test(argText)) contexts.add(argText);
          }
          else if ((name === 'useAtom' || name === 'useAtomValue' || name === 'useSetAtom') && arg && ts.isIdentifier(arg)) stores.add(arg.text);
          else classify(local);
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
          const name = node.expression.expression.text;
          if ((name === 'router' || name === '$inertia') && /^(get|post|put|patch|delete|reload|visit)$/.test(node.expression.name.text)) composables.add(name);
        }
      }
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) mask(node.getStart(sf), node.end);
      ts.forEachChild(node, visit);
    }
    visit(sf);
    if (bindings && (keyedScriptRefs.size || expression && keyedTemplateRefs.size)) {
      const statement = sf.statements[0];
      const model = expression?.directive === 'model' && statement && ts.isExpressionStatement(statement)
        ? unwrapExpression(statement.expression) : undefined;
      function recordKeyUses(node: ts.Node): void {
        if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          const binding = bindings!.binding(node);
          const key = binding ? keyedScriptRefs.get(binding.declaration)
            : expression && !expression.loopBindings?.has(node.text) ? keyedTemplateRefs.get(node.text) : undefined;
          const isName = ts.isVariableDeclaration(parent) && parent.name === node
            || ts.isPropertyAccessExpression(parent) && parent.name === node
            || ts.isPropertyAssignment(parent) && parent.name === node;
          if (key !== undefined && !isName) {
            let target: ts.Node = node;
            let property: string | undefined;
            while ((ts.isPropertyAccessExpression(target.parent) || ts.isElementAccessExpression(target.parent))
              && target.parent.expression === target) {
              target = target.parent;
              if (!property && ts.isPropertyAccessExpression(target)) property = target.name.text;
            }
            const operation = target.parent;
            const assignment = ts.isBinaryExpression(operation) && operation.left === target
              && operation.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && operation.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
            const update = (ts.isPrefixUnaryExpression(operation) || ts.isPostfixUnaryExpression(operation))
              && (operation.operator === ts.SyntaxKind.PlusPlusToken || operation.operator === ts.SyntaxKind.MinusMinusToken);
            const write = target === model || (expression || property === 'value') && (assignment || update);
            recordKey(key, node, write ? 'write' : 'read', property);
          }
        }
        ts.forEachChild(node, recordKeyUses);
      }
      recordKeyUses(sf);
    }
    for (let i = 0; i < masked.length; i++) executable[offset + i] = masked[i];
    if (expression && templateLine !== undefined) {
      const entries = templateBindings.get(templateLine) ?? [];
      entries.push({ expression: masked.join(''), directive: expression.directive });
      templateBindings.set(templateLine, entries);
    }
  }
  const executableContent = executable.join('');

  // 6. Granular tracking of Access Modes (read, write, watch) per dependency
  const items = keyedObservations;
  const lines = executableContent.split('\n');

  interface TrackedDep {
    kind: 'store' | 'context' | 'composable';
    identifier: string;
    instanceVars: Set<string>;
    actionVars: Set<string>;
    readVars: Set<string>;
    destructuredProps: Map<string, string>;
  }

  function parseDestructuredBindings(raw: string): Array<{ sourceProp: string; localVar: string }> {
    const bindings: Array<{ sourceProp: string; localVar: string }> = [];
    for (const part of raw.split(',')) {
      const withoutDefault = part.split('=')[0].trim();
      if (!withoutDefault || withoutDefault.startsWith('...')) continue;
      const colonIdx = withoutDefault.indexOf(':');
      if (colonIdx >= 0) {
        const sourceProp = withoutDefault.slice(0, colonIdx).trim();
        const localVar = withoutDefault.slice(colonIdx + 1).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(sourceProp) && /^[A-Za-z_$][\w$]*$/.test(localVar)) {
          bindings.push({ sourceProp, localVar });
        }
      } else if (/^[A-Za-z_$][\w$]*$/.test(withoutDefault)) {
        bindings.push({ sourceProp: withoutDefault, localVar: withoutDefault });
      }
    }
    return bindings;
  }

  const PINIA_META_MEMBER = /^\$(?:patch|reset|subscribe|onAction|state|id|dispose)$/;

  function collectAccessedProperties(line: string, dep: TrackedDep): string[] {
    const props = new Set<string>();
    for (const inst of dep.instanceVars) {
      const memberRegex = new RegExp(`\\b${escapeRegExp(inst)}\\.([A-Za-z_$][A-Za-z0-9_$]*)\\b`, 'g');
      for (const match of line.matchAll(memberRegex)) {
        if (!PINIA_META_MEMBER.test(match[1])) {
          props.add(match[1]);
        }
      }
    }
    const chainedPropRegex = new RegExp(
      `\\b${escapeRegExp(dep.identifier)}\\s*\\([^)]*\\)\\.([A-Za-z_$][A-Za-z0-9_$]*)\\b`,
      'g'
    );
    for (const match of line.matchAll(chainedPropRegex)) {
      if (!PINIA_META_MEMBER.test(match[1])) {
        props.add(match[1]);
      }
    }
    if (dep.destructuredProps.size > 0) {
      const isDepDeclaration = new RegExp(`\\b${escapeRegExp(dep.identifier)}\\s*\\(`).test(line);
      const isCtxDeclaration = dep.kind === 'context'
        && new RegExp(`\\b(?:useContext|use|inject)\\s*\\(\\s*${escapeRegExp(dep.identifier)}\\b`).test(line);
      if (!isDepDeclaration && !isCtxDeclaration) {
        for (const [localVar, sourceProp] of dep.destructuredProps) {
          if (new RegExp(`\\b${escapeRegExp(localVar)}\\b`).test(line)) {
            props.add(sourceProp);
          }
        }
      }
    }
    return Array.from(props);
  }

  const allTracked: TrackedDep[] = [];

  const addTracked = (ident: string, kind: 'store' | 'context' | 'composable') => {
    const instanceVars = new Set<string>();
    const actionVars = new Set<string>();
    const readVars = new Set<string>();
    const destructuredProps = new Map<string, string>();
    if (ident === 'router' || ident === '$inertia') {
      instanceVars.add(ident);
    }

    // A. Detect instance assignment: const cart = useCartStore() or const form = useForm(...)
    const instRegex = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*(?:await\\s+)?${escapeRegExp(ident)}\\s*\\(`,
      'g'
    );
    for (const match of executableContent.matchAll(instRegex)) {
      instanceVars.add(match[1]);
    }

    // B. Detect destructured actions/state: const { checkout, items } = useCartStore()
    const destructureRegex = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:await\\s+)?${escapeRegExp(ident)}\\s*\\(`,
      'g'
    );
    for (const match of executableContent.matchAll(destructureRegex)) {
      for (const { sourceProp, localVar } of parseDestructuredBindings(match[1])) {
        destructuredProps.set(localVar, sourceProp);
        const isAction =
          /^(?:set|update|delete|add|remove|open|close|mutate|trigger|run|toggle|reset|dispatch|handle|submit|confirm|checkout|post|put|patch|init|initialize|load|fetch|refresh|sync|save|create|clear)/i.test(
            localVar
          ) || localVar.endsWith('Action');
        if (isAction) {
          actionVars.add(localVar);
        } else {
          readVars.add(localVar);
        }
      }
    }

    // C. Detect React array destructuring: const [count, setCount] = useCount()
    const arrayDestructureRegex = new RegExp(
      `(?:const|let|var)\\s*\\[\\s*([A-Za-z0-9_$]+)?\\s*,\\s*([A-Za-z0-9_$]+)\\s*\\]\\s*=\\s*(?:await\\s+)?${escapeRegExp(ident)}\\s*\\(`,
      'g'
    );
    for (const match of executableContent.matchAll(arrayDestructureRegex)) {
      if (match[1]) readVars.add(match[1]);
      if (match[2]) actionVars.add(match[2]);
    }

    // D. Context consumer patterns: const theme = useContext(ThemeContext) or use(ThemeContext)
    if (kind === 'context') {
      const ctxInstRegex = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*(?:await\\s+)?(?:useContext|use|inject)\\s*\\(\\s*${escapeRegExp(ident)}\\b`,
        'g'
      );
      for (const match of executableContent.matchAll(ctxInstRegex)) {
        instanceVars.add(match[1]);
        readVars.add(match[1]);
      }
      const ctxDestructRegex = new RegExp(
        `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:await\\s+)?(?:useContext|use|inject)\\s*\\(\\s*${escapeRegExp(ident)}\\b`,
        'g'
      );
      for (const match of executableContent.matchAll(ctxDestructRegex)) {
        for (const { sourceProp, localVar } of parseDestructuredBindings(match[1])) {
          destructuredProps.set(localVar, sourceProp);
          if (/^(?:set|update|dispatch|toggle|init|initialize|load|fetch|refresh|sync|save|create|clear)/i.test(localVar)) actionVars.add(localVar);
          else readVars.add(localVar);
        }
      }
    }

    // E. Atom store patterns: const [value, setValue] = useAtom(myAtom) or const val = useAtomValue(myAtom)
    if (kind === 'store') {
      const atomArrayRegex = new RegExp(
        `(?:const|let|var)\\s*\\[\\s*([A-Za-z0-9_$]+)?\\s*,\\s*([A-Za-z0-9_$]+)\\s*\\]\\s*=\\s*(?:await\\s+)?(?:useAtom)\\s*\\(\\s*${escapeRegExp(ident)}\\b`,
        'g'
      );
      for (const match of executableContent.matchAll(atomArrayRegex)) {
        if (match[1]) readVars.add(match[1]);
        if (match[2]) actionVars.add(match[2]);
      }
      const atomValRegex = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*(?:await\\s+)?(?:useAtomValue|useStore)\\s*\\(\\s*${escapeRegExp(ident)}\\b`,
        'g'
      );
      for (const match of executableContent.matchAll(atomValRegex)) {
        readVars.add(match[1]);
      }
      const atomSetRegex = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*(?:await\\s+)?(?:useSetAtom)\\s*\\(\\s*${escapeRegExp(ident)}\\b`,
        'g'
      );
      for (const match of executableContent.matchAll(atomSetRegex)) {
        actionVars.add(match[1]);
      }
    }

    allTracked.push({ kind, identifier: ident, instanceVars, actionVars, readVars, destructuredProps });
  };

  for (const s of stores) if (!observedKeys.has(s)) addTracked(s, 'store');
  for (const c of contexts) addTracked(c, 'context');
  for (const cmp of composables) addTracked(cmp, 'composable');

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];
    const trimmed = sourceLines[idx].trim();
    if (!line.trim()) continue;

    for (const dep of allTracked) {
      let matchedMode: StateAccessMode | null = null;
      let snippet: string | undefined;

      // 1. Check watch
      const hasWatch = /\bwatch(?:Effect|PostEffect)?\s*\(/.test(line);
      const mentionsDep =
        line.includes(dep.identifier) ||
        Array.from(dep.instanceVars).some((v) => new RegExp(`\\b${escapeRegExp(v)}\\b`).test(line)) ||
        Array.from(dep.readVars).some((v) => new RegExp(`\\b${escapeRegExp(v)}\\b`).test(line));

      if (hasWatch && mentionsDep) {
        matchedMode = 'watch';
        snippet = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
      }

      // 2. Check write actions
      if (!matchedMode) {
        // Direct method call on instance: cart.checkout(), router.post(), auth.login()
        for (const inst of dep.instanceVars) {
          const methodCallRegex = new RegExp(`\\b${escapeRegExp(inst)}\\.([A-Za-z0-9_$]+)\\s*\\(`, 'g');
          const methodMatch = Array.from(line.matchAll(methodCallRegex)).find(match => !PURE_GETTER.test(match[1]));
          if (methodMatch) {
            matchedMode = 'write';
            snippet = `${inst}.${methodMatch[1]}()`;
            break;
          }
          // Direct mutation: cart.count++, cart.foo = 'bar', cart.$patch(...)
          const mutationRegex = new RegExp(
            `\\b${escapeRegExp(inst)}(?:\\.[A-Za-z0-9_$]+)+\\s*(?:\\+\\+|--|(?:\\*\\*|&&|\\|\\||\\?\\?|>>>|>>|<<|[+*/%&|^\\x2d])?=(?!=|>))`
          );
          if (mutationRegex.test(line)) {
            matchedMode = 'write';
            snippet = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
            break;
          }
        }
      }

      if (!matchedMode) {
        // Invoking destructured action: checkout(), setCount(), dispatch(), logout(), login()
        for (const act of dep.actionVars) {
          if (new RegExp(`\\b${escapeRegExp(act)}\\s*\\(`).test(line)) {
            matchedMode = 'write';
            snippet = `${act}()`;
            break;
          }
        }
        if (!matchedMode) {
          for (const rv of dep.readVars) {
            if (!PURE_GETTER.test(rv) && new RegExp(`\\b${escapeRegExp(rv)}\\s*\\(`).test(line)) {
              matchedMode = 'write';
              snippet = `${rv}()`;
              break;
            }
          }
        }
      }

      if (!matchedMode) {
        // Direct chained call: useCartStore().checkout() or useConfirm().confirm()
        const chainedRegex = new RegExp(
          `\\b${escapeRegExp(dep.identifier)}\\s*\\([^)]*\\)\\.([A-Za-z0-9_$]+)\\s*\\(`
        );
        const chainMatch = chainedRegex.exec(line);
        if (chainMatch && !PURE_GETTER.test(chainMatch[1])) {
          matchedMode = 'write';
          snippet = `${dep.identifier}().${chainMatch[1]}()`;
        }
      }

      // Directive semantics are lost when their value is parsed as plain JavaScript.
      for (const binding of templateBindings.get(lineNum) ?? []) {
        const exp = binding.expression.trim();
        const member = /^([A-Za-z_$][\w$]*)\.([\w$.]+)$/.exec(exp);
        const instanceMember = member && dep.instanceVars.has(member[1]);
        const localState = dep.readVars.has(exp) || dep.actionVars.has(exp);
        if (binding.directive === 'model' && (instanceMember || localState)
          || binding.directive === 'on' && (instanceMember && !PURE_GETTER.test(member![2].split('.').pop()!) || localState && !PURE_GETTER.test(exp))) {
          matchedMode = 'write';
          snippet = exp;
        }
      }

      // 3. Check read
      if (!matchedMode) {
        const isRead =
          line.includes(dep.identifier) ||
          Array.from(dep.instanceVars).some((v) => new RegExp(`\\b${escapeRegExp(v)}\\b`).test(line)) ||
          Array.from(dep.readVars).some((v) => new RegExp(`\\b${escapeRegExp(v)}\\b`).test(line));

        if (isRead) {
          matchedMode = 'read';
          snippet = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
        }
      }

      if (matchedMode) {
        const accessedProperties = collectAccessedProperties(line, dep);
        items.push({
          kind: dep.kind,
          identifier: dep.identifier,
          accessMode: matchedMode,
          lineNumber: lineNum,
          usageSnippet: snippet,
          ...(accessedProperties.length > 0 ? { accessedProperties } : {}),
        });
      }
    }
  }

  // Ensure every identified dependency has at least 1 record in items (fallback if unused in template/script body)
  for (const dep of allTracked) {
    const hasItem = items.some((it) => it.identifier === dep.identifier);
    if (!hasItem) {
      items.push({
        kind: dep.kind,
        identifier: dep.identifier,
        accessMode: 'read',
        lineNumber: 1,
        usageSnippet: dep.identifier,
      });
    }
  }

  return {
    stores: Array.from(stores),
    contexts: Array.from(contexts),
    composables: Array.from(composables),
    items,
  };
}

/**
 * Extracts data lineage dependencies (Server Actions, TanStack Query keys, API endpoints, and mutations).
 */
export function extractDataDependencies(
  content: string,
  _framework: FrontendFramework | 'vue-composable' | string
): DataDependencyInfo | undefined {
  const serverActions = new Set<string>();
  const queryKeys = new Set<string>();
  const endpoints = new Set<string>();
  const mutations = new Set<string>();

  // 1. Server Actions ('use server' functions or action imports)
  const inlineServerActionRegex = /async\s+function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*['"]use server['"]/g;
  for (const m of content.matchAll(inlineServerActionRegex)) {
    serverActions.add(m[1]);
  }

  const actionImportRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]*(?:actions|server|mutations)[^'"]*['"]/g;
  for (const m of content.matchAll(actionImportRegex)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    names.forEach((n) => serverActions.add(n));
  }

  const isNextOrServerModule =
    _framework === 'next' ||
    content.includes("'use server'") ||
    content.includes('"use server"');

  if (isNextOrServerModule) {
    const actionFunctionCallRegex = /\b([a-z][A-Za-z0-9_$]*Action)\s*\(/g;
    for (const m of content.matchAll(actionFunctionCallRegex)) {
      serverActions.add(m[1]);
    }
  }

  // 2. TanStack Query / SWR / Vue Query
  const tanstackObjectRegex = /useQuery\s*\(\s*\{[\s\S]*?queryKey\s*:\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(tanstackObjectRegex)) {
    queryKeys.add(m[1].replace(/\s+/g, ' ').trim());
  }

  const tanstackArrayRegex = /useQuery\s*\(\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(tanstackArrayRegex)) {
    queryKeys.add(m[1].replace(/\s+/g, ' ').trim());
  }

  const swrRegex = /useSWR\s*(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(swrRegex)) {
    queryKeys.add(`"${m[1]}"`);
    if (m[1].startsWith('/') || m[1].startsWith('http')) {
      endpoints.add(m[1]);
    }
  }

  // 3. HTTP Endpoints ($fetch, fetch, axios, api)
  const fetchRegex = /(?:\$fetch|fetch|axios\.(?:get|post|put|delete|patch)|api\.(?:get|post|put|delete|patch))\s*(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of content.matchAll(fetchRegex)) {
    const url = m[1].trim();
    if (url && (url.startsWith('/') || url.startsWith('http') || url.startsWith('api/'))) {
      endpoints.add(url);
    }
  }

  const nuxtFetchRegex = /\b(?:useFetch|useLazyFetch)\s*(?:<[^>]+>)?\s*\(\s*(?:['"`]([^'"`]+)['"`]|\(\)\s*=>\s*['"`]([^'"`]+)['"`])/g;
  for (const m of content.matchAll(nuxtFetchRegex)) {
    const url = (m[1] || m[2])?.trim();
    if (url && (url.startsWith('/') || url.startsWith('http') || url.startsWith('api/'))) {
      endpoints.add(url);
    }
  }

  const useAsyncDataRegex = /\b(?:useAsyncData|useLazyAsyncData)\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(useAsyncDataRegex)) {
    queryKeys.add(`"${m[1]}"`);
  }

  // 4. Inertia.js Form & Router Mutations (direct URLs, route('...') helpers, and partial reloads)
  const inertiaMutationRegex = /(?:[A-Za-z0-9_$]+|router)\.(post|put|patch|delete)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`])/g;
  for (const m of content.matchAll(inertiaMutationRegex)) {
    const method = m[1].toUpperCase();
    const routeTarget = m[2] ? `route('${m[2]}')` : m[3]?.trim();
    if (routeTarget) {
      mutations.add(`${method} ${routeTarget}`);
      if (routeTarget.startsWith('/') || routeTarget.startsWith('http')) {
        endpoints.add(routeTarget);
      }
    }
  }

  const inertiaReloadRegex = /router\.reload\s*\(\s*\{[\s\S]*?only\s*:\s*\[([^\]]+)\]/g;
  for (const m of content.matchAll(inertiaReloadRegex)) {
    const propsReloaded = m[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    for (const p of propsReloaded) {
      mutations.add(`RELOAD prop:${p}`);
    }
  }

  const result: DataDependencyInfo = {};
  if (serverActions.size > 0) result.serverActions = Array.from(serverActions);
  if (queryKeys.size > 0) result.queryKeys = Array.from(queryKeys);
  if (endpoints.size > 0) result.endpoints = Array.from(endpoints);
  if (mutations.size > 0) result.mutations = Array.from(mutations);

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Infers deep object prop sub-properties accessed across template and script blocks.
 */
