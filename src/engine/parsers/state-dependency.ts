import type {
  DataDependencyInfo,
  StateAccessMode,
  StateDependencyInfo,
  StateDependencyItem,
} from '../../types';
import { COMMON_HOOKS_IGNORE } from '../contract';
import { escapeRegExp } from '../patterns';
import ts from 'typescript';
import type { FrontendFramework } from '../../types';
import { createDocumentAdapter } from '../../adapters/factory';
import { extractTemplateExpressions } from '../template';

export function extractStateDependencies(
  content: string,
  _framework: FrontendFramework | 'vue-composable' | string,
  selfComponentName?: string
): StateDependencyInfo {
  const stores = new Set<string>();
  const contexts = new Set<string>();
  const composables = new Set<string>();

  const markup = /^\s*<(?:template|script)\b/.test(content);
  const astro = /^\s*---/.test(content);
  const leading = astro ? content.length - content.trimStart().length : 0;
  const adapter = createDocumentAdapter(astro ? 'file.astro' : markup ? 'file.vue' : 'file.tsx', content.slice(leading));
  const blocks = adapter.getScriptBlocks().map(b => ({ code: b.content, offset: leading + b.loc.start.offset }));
  if (astro && !blocks.length) {
    const match = content.match(/^\s*---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*---/);
    if (match) blocks.push({ code: match[1], offset: content.indexOf(match[1], leading + 3) });
  }
  const template = adapter.getTemplateBlock();
  if (template && adapter.type === 'vue') {
    for (const exp of extractTemplateExpressions(template.content)) {
      const lines = template.content.split('\n');
      const offset = lines.slice(0, exp.start.line - 1).reduce((n, line) => n + line.length + 1, 0) + exp.start.column - 1;
      blocks.push({ code: exp.content, offset: leading + template.loc.start.offset + offset });
    }
  }
  const declaredDefinitions = new Set<string>();
  const aliases = new Map<string, string>();
  const storeRegex = /^use[A-Za-z0-9_$]*Store$/;
  const reduxRegex = /^(useSelector|useDispatch|useAppSelector|useAppDispatch)$/;
  const hookRegex = /^use[A-Z][A-Za-z0-9_$]*$/;
  const parsed = blocks.map(b => ({ ...b, sf: ts.createSourceFile('file.tsx', b.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }));
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
    const { sf, code, offset } = block;
    const masked = code.split('');
    const mask = (start: number, end: number) => { for (let i = start; i < end; i++) if (masked[i] !== '\n' && masked[i] !== '\r') masked[i] = ' '; };
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, code);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) mask(scanner.getTokenPos(), scanner.getTextPos());
    }
    function visit(node: ts.Node): void {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isImportSpecifier(node) && node.isTypeOnly)) { mask(node.getStart(sf), node.end); return; }
      if (ts.isImportSpecifier(node)) classify(node.name.text);
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const local = node.expression.text;
          const name = aliases.get(local) ?? local;
          const arg = node.arguments[0];
          if (name === 'useStore' && arg && ts.isIdentifier(arg)) stores.add(arg.text);
          else if (name === 'useState' && arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg))) stores.add(arg.text);
          else if ((name === 'useContext' || name === 'inject') && arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg))) contexts.add(arg.text);
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
    for (let i = 0; i < masked.length; i++) executable[offset + i] = masked[i];
  }
  const executableContent = executable.join('');

  // 6. Granular tracking of Access Modes (read, write, watch) per dependency
  const items: StateDependencyItem[] = [];
  const lines = executableContent.split('\n');
  const sourceLines = content.split('\n');

  interface TrackedDep {
    kind: 'store' | 'context' | 'composable';
    identifier: string;
    instanceVars: Set<string>;
    actionVars: Set<string>;
    readVars: Set<string>;
  }

  const allTracked: TrackedDep[] = [];

  const addTracked = (ident: string, kind: 'store' | 'context' | 'composable') => {
    const instanceVars = new Set<string>();
    const actionVars = new Set<string>();
    const readVars = new Set<string>();

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
      const vars = match[1]
        .split(',')
        .map((v) => v.trim().split(':')[0].trim())
        .filter(Boolean);
      for (const v of vars) {
        const isAction =
          /^(?:set|update|delete|add|remove|open|close|mutate|trigger|run|toggle|reset|dispatch|handle|submit|confirm|checkout|post|put|patch)/i.test(
            v
          ) || v.endsWith('Action');
        if (isAction) {
          actionVars.add(v);
        } else {
          readVars.add(v);
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
        const vars = match[1].split(',').map((v) => v.trim().split(':')[0].trim()).filter(Boolean);
        for (const v of vars) {
          if (/^(?:set|update|dispatch|toggle)/i.test(v)) actionVars.add(v);
          else readVars.add(v);
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

    allTracked.push({ kind, identifier: ident, instanceVars, actionVars, readVars });
  };

  for (const s of stores) addTracked(s, 'store');
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
          const methodMatch = methodCallRegex.exec(line);
          if (methodMatch) {
            matchedMode = 'write';
            snippet = `${inst}.${methodMatch[1]}()`;
            break;
          }
          // Direct mutation: cart.count++, cart.foo = 'bar', cart.$patch(...)
          const mutationRegex = new RegExp(
            `\\b${escapeRegExp(inst)}\\.(?:\\$patch|\\$reset|[A-Za-z0-9_$]+(?:\\+\\+|--|\\s*=[^=]))`
          );
          if (mutationRegex.test(line)) {
            matchedMode = 'write';
            snippet = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
            break;
          }
        }
      }

      if (!matchedMode) {
        // Invoking destructured action: checkout(), setCount(), dispatch()
        for (const act of dep.actionVars) {
          if (new RegExp(`\\b${escapeRegExp(act)}\\s*\\(`).test(line)) {
            matchedMode = 'write';
            snippet = `${act}()`;
            break;
          }
        }
      }

      if (!matchedMode) {
        // Direct chained call: useCartStore().checkout() or useConfirm().confirm()
        const chainedRegex = new RegExp(
          `\\b${escapeRegExp(dep.identifier)}\\s*\\([^)]*\\)\\.([A-Za-z0-9_$]+)\\s*\\(`
        );
        const chainMatch = chainedRegex.exec(line);
        if (chainMatch) {
          matchedMode = 'write';
          snippet = `${dep.identifier}().${chainMatch[1]}()`;
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
        items.push({
          kind: dep.kind,
          identifier: dep.identifier,
          accessMode: matchedMode,
          lineNumber: lineNum,
          usageSnippet: snippet,
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

  const actionFunctionCallRegex = /\b([A-Za-z0-9_$]+Action)\s*\(/g;
  for (const m of content.matchAll(actionFunctionCallRegex)) {
    serverActions.add(m[1]);
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
 * Infers item fields of an array property iterated via Vue/Nuxt `v-for` or React/Next/Astro `.map()`.
 * Produces structured shapes like `Array<{ id, title, price, customer?: { name } }>`.
 */
export function inferArrayItemShape(
  content: string,
  propName: string,
  property?: string
): string | null {
  const aliases = new Set<string>();

  // 1. Vue/Nuxt v-for: v-for="item in prop.data" or v-for="(item, idx) in prop.data"
  const vForTarget = property
    ? `${propName}(?:\\.value)?(?:\\?\\.)?\\.${property}\\b`
    : `${propName}(?:\\.value)?(?![\\.\\?])\\b`;

  const vForRegex = new RegExp(
    `v-for=['"][^'"]*?(?:\\(\\s*([A-Za-z0-9_$]+)(?:\\s*,[^)]*)?\\)|([A-Za-z0-9_$]+))\\s+(?:in|of)\\s+[^'"]*?\\b(?:props\\.)?${vForTarget}`,
    'gi'
  );
  for (const match of content.matchAll(vForRegex)) {
    const alias = match[1] || match[2];
    if (alias && alias !== 'index' && alias !== 'idx' && alias !== 'key') {
      aliases.add(alias);
    }
  }

  // 2. React / Next.js / Astro / JSX .map(): prop.data.map((item) => ...) or prop.map((item) => ...)
  const mapTarget = property
    ? `${propName}(?:\\.value)?(?:\\?\\.)?\\.${property}(?:\\?\\.)?\\.map`
    : `${propName}(?:\\.value)?(?:\\?\\.)?\\.map`;

  const mapRegex = new RegExp(
    `\\b(?:props\\.)?${mapTarget}\\s*\\(\\s*(?:\\(\\s*([A-Za-z0-9_$]+)(?:\\s*,[^)]*)?\\)|([A-Za-z0-9_$]+))\\s*=>`,
    'gi'
  );
  for (const match of content.matchAll(mapRegex)) {
    const alias = match[1] || match[2];
    if (alias && alias !== 'index' && alias !== 'idx' && alias !== 'key') {
      aliases.add(alias);
    }
  }

  if (aliases.size === 0) return null;

  const itemFields = new Map<string, Set<string> | null>();
  const ignoreMethods = new Set([
    'map', 'filter', 'forEach', 'reduce', 'length', 'toString', 'valueOf',
    'includes', 'find', 'findIndex', 'some', 'every', 'slice', 'splice', 'push'
  ]);

  for (const alias of aliases) {
    // Check 2-level deep: alias.field.nestedField or alias.field?.nestedField
    const nestedAccessRegex = new RegExp(
      `\\b${alias}(?:\\?\\.|\\.)([A-Za-z0-9_$]+)(?:\\?\\.|\\.)([A-Za-z0-9_$]+)`,
      'g'
    );
    for (const m of content.matchAll(nestedAccessRegex)) {
      const parentField = m[1];
      const childField = m[2];
      if (parentField && childField && !ignoreMethods.has(childField)) {
        if (!itemFields.has(parentField) || itemFields.get(parentField) === null) {
          itemFields.set(parentField, new Set<string>());
        }
        itemFields.get(parentField)!.add(childField);
      }
    }

    // Single level: alias.field or alias?.field
    const accessRegex = new RegExp(
      `\\b${alias}(?:\\?\\.|\\.)([A-Za-z0-9_$]+)`,
      'g'
    );
    for (const m of content.matchAll(accessRegex)) {
      const field = m[1];
      if (field && !ignoreMethods.has(field)) {
        if (!itemFields.has(field)) {
          itemFields.set(field, null);
        }
      }
    }
  }

  if (itemFields.size === 0) return null;

  const fieldStrings: string[] = [];
  for (const [f, nested] of itemFields.entries()) {
    if (nested && nested.size > 0) {
      fieldStrings.push(`${f}?: { ${Array.from(nested).join(', ')} }`);
    } else {
      fieldStrings.push(f);
    }
  }

  return `Array<{ ${fieldStrings.join(', ')} }>`;
}

/**
 * Infers deep object prop sub-properties accessed across template and script blocks.
 */
