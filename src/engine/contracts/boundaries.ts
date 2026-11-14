import type { BoundaryContract, BoundaryMethod, FormContract, FormFieldContract } from '../../types';
import { synthesizeBackendTargetHint } from '../api-contract';

/**
 * Computes 1-based line number from a character offset.
 */
export function getLineFromOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Extracts payload object property keys from a JS object literal snippet.
 */
export function extractObjectLiteralKeys(objSnippet: string): string[] {
  const keys: string[] = [];
  const keyRegex = /(?:^|[{,\n])\s*([A-Za-z0-9_$]+)\s*:/g;
  for (const m of objSnippet.matchAll(keyRegex)) {
    if (m[1] && m[1] !== 'method' && m[1] !== 'headers' && m[1] !== 'params' && m[1] !== 'body' && m[1] !== 'key') {
      keys.push(m[1]);
    }
  }
  return keys;
}

/**
 * Extracts universal ingress & egress data fetching boundary contracts (Inertia, Nuxt, Next/React, Astro).
 */
export function extractBoundaryContracts(
  content: string,
  _framework: string
): BoundaryContract[] {
  const boundaries: BoundaryContract[] = [];

  // 1. Inertia useForm: const form = useForm({ ... })
  const formVarFields = new Map<string, string[]>();
  const inertiaUseFormRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*useForm\s*(?:<[^>]+>)?\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?(\{[\s\S]*?\})\s*\)/g;
  for (const m of content.matchAll(inertiaUseFormRegex)) {
    const varName = m[1];
    const fields = extractObjectLiteralKeys(m[2]);
    formVarFields.set(varName, fields);
  }

  // 1b. Inertia form submissions: form.post(...), form.put(...), etc.
  const formSubmitRegex = /\b([A-Za-z0-9_$]+)\.(post|put|patch|delete|get)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`]|([A-Za-z0-9_$]+))/g;
  for (const m of content.matchAll(formSubmitRegex)) {
    const varName = m[1];
    if (varName === 'axios' || varName === 'router' || varName === 'api' || varName === 'http') {
      continue;
    }
    const isKnownForm = formVarFields.has(varName) || /form/i.test(varName);
    if (!isKnownForm) {
      continue;
    }

    const method = m[2].toUpperCase() as BoundaryMethod;
    const isZiggy = Boolean(m[3]);
    const ziggyName = m[3];
    const literalUrl = m[4];
    const varUrl = m[5];

    let targetEndpoint = '';
    let endpointSource: BoundaryContract['endpointSource'] = 'literal';

    if (isZiggy) {
      targetEndpoint = `route('${ziggyName}')`;
      endpointSource = 'ziggy-route';
    } else if (literalUrl) {
      targetEndpoint = literalUrl.trim();
      endpointSource = literalUrl.includes('${') ? 'template-literal' : 'literal';
    } else if (varUrl) {
      targetEndpoint = varUrl.trim();
      endpointSource = 'variable';
    }

    if (targetEndpoint) {
      const payloadKeys = formVarFields.get(varName) || [];
      const line = getLineFromOffset(content, m.index || 0);
      boundaries.push({
        boundaryType: 'inertia-form',
        method,
        targetEndpoint,
        endpointSource,
        payloadKeys: payloadKeys.length > 0 ? payloadKeys : undefined,
        optimisticUpdate: false,
        loc: { line },
        backendTargetHint: synthesizeBackendTargetHint(method, targetEndpoint),
      });
    }
  }

  // 1c. Inertia router calls: router.post(...), router.visit(...)
  const inertiaRouterRegex = /\brouter\.(post|put|patch|delete|get|visit)\s*\(\s*(?:route\s*\(\s*['"]([^'"]+)['"]|['"`]([^'"`]+)['"`])/g;
  for (const m of content.matchAll(inertiaRouterRegex)) {
    const rawMethod = m[1].toUpperCase();
    const method = (rawMethod === 'VISIT' ? 'GET' : rawMethod) as BoundaryMethod;
    const isZiggy = Boolean(m[2]);
    const targetEndpoint = isZiggy ? `route('${m[2]}')` : (m[3]?.trim() || '');
    const endpointSource = isZiggy ? 'ziggy-route' : (targetEndpoint.includes('${') ? 'template-literal' : 'literal');
    const line = getLineFromOffset(content, m.index || 0);

    const afterCall = content.substring((m.index || 0) + m[0].length);
    let payloadKeys: string[] | undefined;
    const secondArgMatch = afterCall.match(/^\s*,\s*(\{[\s\S]*?\})/);
    if (secondArgMatch) {
      payloadKeys = extractObjectLiteralKeys(secondArgMatch[1]);
    }

    boundaries.push({
      boundaryType: 'inertia-router',
      method,
      targetEndpoint,
      endpointSource,
      payloadKeys: payloadKeys && payloadKeys.length > 0 ? payloadKeys : undefined,
      optimisticUpdate: false,
      backendTargetHint: synthesizeBackendTargetHint(method, targetEndpoint),
      loc: { line }
    });
  }

  // 2. Nuxt useFetch & $fetch
  const nuxtFetchRegex = /\b(useFetch|\$fetch)\s*(?:<[^>]+>)?\s*\(\s*['"`]([^'"`]+)['"`](?:[\s\S]*?method\s*:\s*['"]([A-Za-z]+)['"])?/g;
  for (const m of content.matchAll(nuxtFetchRegex)) {
    const targetEndpoint = m[2].trim();
    const method = (m[3]?.toUpperCase() || 'GET') as BoundaryMethod;
    const line = getLineFromOffset(content, m.index || 0);
    const endpointSource = targetEndpoint.includes('${') ? 'template-literal' : 'literal';

    let payloadKeys: string[] | undefined;
    const afterMatch = content.substring(m.index || 0, (m.index || 0) + 300);
    const bodyMatch = afterMatch.match(/body\s*:\s*(\{[\s\S]*?\})/);
    if (bodyMatch) {
      payloadKeys = extractObjectLiteralKeys(bodyMatch[1]);
    }

    boundaries.push({
      boundaryType: 'nuxt-fetch',
      method,
      targetEndpoint,
      endpointSource,
      payloadKeys: payloadKeys && payloadKeys.length > 0 ? payloadKeys : undefined,
      optimisticUpdate: false,
      loc: { line }
    });
  }

  // 3. TanStack Query: useMutation / useQuery
  const tanstackMutationRegex = /useMutation\s*\(\s*\{[\s\S]*?mutationFn\s*:\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/g;
  for (const m of content.matchAll(tanstackMutationRegex)) {
    const line = getLineFromOffset(content, m.index || 0);
    const mutationBlock = content.substring(m.index || 0, (m.index || 0) + 400);
    const urlMatch = mutationBlock.match(/['"`](\/(?:api\/)?[^'"`]+)['"`]/);
    const targetEndpoint = urlMatch ? urlMatch[1] : 'mutationFn';
    const methodMatch = mutationBlock.match(/method\s*:\s*['"]([A-Z]+)['"]/i) || mutationBlock.match(/\.(post|put|patch|delete)\b/i);
    const method = (methodMatch ? (methodMatch[1] || methodMatch[2]).toUpperCase() : 'POST') as BoundaryMethod;

    boundaries.push({
      boundaryType: 'tanstack-query',
      method,
      targetEndpoint,
      endpointSource: urlMatch ? (targetEndpoint.includes('${') ? 'template-literal' : 'literal') : 'action-symbol',
      optimisticUpdate: /onMutate\s*:/.test(mutationBlock),
      loc: { line }
    });
  }

  // 4. Server Actions (Next.js / Astro actions)
  const serverActionRegex = /(?:action\s*=\s*\{([A-Za-z0-9_$]+)\}|async\s+function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*['"]use server['"])/g;
  for (const m of content.matchAll(serverActionRegex)) {
    const actionName = m[1] || m[2];
    const line = getLineFromOffset(content, m.index || 0);
    boundaries.push({
      boundaryType: 'server-action',
      method: 'POST',
      targetEndpoint: actionName,
      endpointSource: 'action-symbol',
      optimisticUpdate: false,
      loc: { line }
    });
  }

  // 5. Native fetch & Axios
  const nativeFetchRegex = /\bfetch\s*\(\s*['"`](\/(?:api\/)?[^'"`]+)['"`](?:[\s\S]*?method\s*:\s*['"]([A-Za-z]+)['"])?/g;
  for (const m of content.matchAll(nativeFetchRegex)) {
    const targetEndpoint = m[1].trim();
    const method = (m[2]?.toUpperCase() || 'GET') as BoundaryMethod;
    const line = getLineFromOffset(content, m.index || 0);

    const alreadyCaptured = boundaries.some(
      (b) => b.loc?.line === line || (b.targetEndpoint === targetEndpoint && b.boundaryType === 'tanstack-query')
    );
    if (!alreadyCaptured) {
      boundaries.push({
        boundaryType: 'native-fetch',
        method,
        targetEndpoint,
        endpointSource: targetEndpoint.includes('${') ? 'template-literal' : 'literal',
        loc: { line }
      });
    }
  }

  // 5b. Axios calls: axios.get(...), axios.post(...)
  const axiosRegex = /\baxios\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of content.matchAll(axiosRegex)) {
    const method = m[1].toUpperCase() as BoundaryMethod;
    const targetEndpoint = m[2].trim();
    const line = getLineFromOffset(content, m.index || 0);
    const alreadyCaptured = boundaries.some(
      (b) => b.loc?.line === line || (b.targetEndpoint === targetEndpoint && b.boundaryType === 'tanstack-query')
    );
    if (!alreadyCaptured) {
      const endpointSource = targetEndpoint.includes('${') ? 'template-literal' : 'literal';
      boundaries.push({
        boundaryType: 'axios',
        method,
        targetEndpoint,
        endpointSource,
        loc: { line },
        backendTargetHint: synthesizeBackendTargetHint(method, targetEndpoint),
      });
    }
  }

  return boundaries;
}

/**
 * Extracts form and input payload dictionary across template/JSX and script blocks.
 */
export function extractFormContracts(
  content: string,
  templateContent?: string
): FormContract[] {
  const forms: FormContract[] = [];
  const fields: FormFieldContract[] = [];
  const fieldKeySet = new Set<string>();
  let isMultipart = false;

  const searchContent = templateContent || content;

  // 1. Scan template tags: <input>, <select>, <textarea>, <Input, <Select, <Textarea
  const tagRegex = /<(?:input|select|textarea|Input|Select|Textarea)\b([^>]*?)(?:\/?>|>)/gi;
  for (const m of searchContent.matchAll(tagRegex)) {
    const attrs = m[1];

    const typeMatch = attrs.match(/\btype=['"]([^'"]+)['"]/i);
    const rawType = typeMatch ? typeMatch[1].toLowerCase() : 'text';

    if (rawType === 'file') {
      isMultipart = true;
    }

    const isRequired = /\brequired\b/i.test(attrs) || /:required=['"]true['"]/i.test(attrs);

    let key = '';
    let binding: string | undefined;

    const vModelMatch = attrs.match(/v-model(?::[A-Za-z0-9_$]+)?=['"]([^'"]+)['"]/i);
    if (vModelMatch) {
      binding = vModelMatch[1].trim();
      const parts = binding.split('.');
      key = parts[parts.length - 1];
    } else {
      const nameMatch = attrs.match(/\bname=['"]([^'"]+)['"]/i);
      if (nameMatch) {
        key = nameMatch[1].trim();
        binding = key;
      }
    }

    if (key && !fieldKeySet.has(key)) {
      fieldKeySet.add(key);
      fields.push({
        key,
        type: rawType,
        required: isRequired,
        binding
      });
    }
  }

  // 2. Scan script for useForm({ ... }) initial keys
  const inertiaUseFormRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*useForm\s*(?:<[^>]+>)?\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?(\{[\s\S]*?\})\s*\)/g;
  for (const m of content.matchAll(inertiaUseFormRegex)) {
    const bindingName = m[1];
    const declaredKeys = extractObjectLiteralKeys(m[2]);

    for (const k of declaredKeys) {
      if (!fieldKeySet.has(k)) {
        fieldKeySet.add(k);
        const isFileField = new RegExp(`${k}\\s*:\\s*(?:null|new File)`).test(m[2]);
        fields.push({
          key: k,
          type: isFileField ? 'file' : 'unknown',
          required: false,
          binding: `${bindingName}.${k}`
        });
        if (isFileField) isMultipart = true;
      }
    }
  }

  if (fields.length > 0 || isMultipart) {
    forms.push({
      binding: 'form',
      isMultipart,
      fields
    });
  }

  return forms;
}
