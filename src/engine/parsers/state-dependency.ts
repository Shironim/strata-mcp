import type {
  DataDependencyInfo,
  StateAccessMode,
  StateDependencyInfo,
  StateDependencyItem,
} from '../../types';
import { COMMON_HOOKS_IGNORE } from '../contract';
import { escapeRegExp } from '../patterns';

export function extractStateDependencies(
  content: string,
  _framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable',
  selfComponentName?: string
): StateDependencyInfo {
  const stores = new Set<string>();
  const contexts = new Set<string>();
  const composables = new Set<string>();

  // Collect symbols declared/defined in this file to avoid self-dependency (e.g. export function useCartStore())
  const declaredDefinitions = new Set<string>();
  const declRegex = /(?:export\s+)?(?:default\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
  for (const m of content.matchAll(declRegex)) {
    declaredDefinitions.add(m[1]);
  }

  // 1. Stores: Pinia / Zustand / Redux
  const storeRegex = /\b(use[A-Za-z0-9_$]*Store)\b/g;
  for (const m of content.matchAll(storeRegex)) {
    if (m[1] !== selfComponentName && !declaredDefinitions.has(m[1])) {
      stores.add(m[1]);
    }
  }

  const reduxRegex = /\b(useSelector|useDispatch|useAppSelector|useAppDispatch)\b/g;
  for (const m of content.matchAll(reduxRegex)) {
    stores.add(m[1]);
  }

  // 2. React Context & Vue inject
  const contextRegex = /\buseContext\(\s*([A-Za-z0-9_$]+)\s*\)/g;
  for (const m of content.matchAll(contextRegex)) {
    contexts.add(m[1]);
  }

  const vueInjectRegex = /\binject(?:\s*<[^>]*>)?\(\s*['"]?([A-Za-z0-9_$-]+)['"]?/g;
  for (const m of content.matchAll(vueInjectRegex)) {
    if (m[1]) contexts.add(m[1]);
  }

  // 3. Custom Composables / Hooks (useXxx)
  const hookRegex = /\b(use[A-Z][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of content.matchAll(hookRegex)) {
    const hookName = m[1];
    if (
      !COMMON_HOOKS_IGNORE.has(hookName) &&
      !stores.has(hookName) &&
      hookName !== 'useContext' &&
      hookName !== selfComponentName &&
      !declaredDefinitions.has(hookName)
    ) {
      composables.add(hookName);
    }
  }

  // 4. Inertia Router singleton (Vue 3, React, Svelte, Core) & $inertia global
  const inertiaRouterImportRegex = /\bimport\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]@inertiajs\/(?:vue3|react|svelte|core)['"]/;
  const inertiaRouterUsageRegex = /\brouter\.(?:get|post|put|patch|delete|reload|visit)\b/;
  if (inertiaRouterImportRegex.test(content) || inertiaRouterUsageRegex.test(content)) {
    composables.add('router');
  }

  const inertiaGlobalRegex = /\b\$inertia\.(?:get|post|put|patch|delete|reload|visit)\b/;
  if (inertiaGlobalRegex.test(content)) {
    composables.add('$inertia');
  }

  // 5. Nanostores atom extraction (Astro, React, Vue): useStore($atom)
  const nanostoresRegex = /\buseStore\(\s*([$A-Za-z0-9_]+)\s*\)/g;
  for (const nm of content.matchAll(nanostoresRegex)) {
    if (nm[1]) {
      stores.add(nm[1]);
    }
  }

  // 6. Granular tracking of Access Modes (read, write, watch) per dependency
  const items: StateDependencyItem[] = [];
  const lines = content.split('\n');

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
    for (const match of content.matchAll(instRegex)) {
      instanceVars.add(match[1]);
    }

    // B. Detect destructured actions/state: const { checkout, items } = useCartStore()
    const destructureRegex = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:await\\s+)?${escapeRegExp(ident)}\\s*\\(`,
      'g'
    );
    for (const match of content.matchAll(destructureRegex)) {
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
    for (const match of content.matchAll(arrayDestructureRegex)) {
      if (match[1]) readVars.add(match[1]);
      if (match[2]) actionVars.add(match[2]);
    }

    allTracked.push({ kind, identifier: ident, instanceVars, actionVars, readVars });
  };

  for (const s of stores) addTracked(s, 'store');
  for (const c of contexts) addTracked(c, 'context');
  for (const cmp of composables) addTracked(cmp, 'composable');

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

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
  _framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable'
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

  const useAsyncDataRegex = /useAsyncData\s*\(\s*['"]([^'"]+)['"]/g;
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
