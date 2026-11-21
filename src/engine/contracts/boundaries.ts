import type { BoundaryContract, BoundaryMethod, FormContract, FormFieldContract } from '../../types';
import { synthesizeBackendTargetHint } from './backend-target-hint';
import { observeHttpDocument } from './outbound-http';

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

function boundaryDocumentPath(content: string, framework: string): string {
  if (/^\s*---(?:\r?\n)/.test(content)) return 'component.astro';
  if (framework === 'svelte' && /<script\b/.test(content)) return 'component.svelte';
  if (/<(?:script|template)(?:\s|>)/.test(content)) return 'component.vue';
  return framework === 'react' || framework === 'next' ? 'component.tsx' : 'component.ts';
}

/**
 * Extracts universal ingress & egress data fetching boundary contracts (Inertia, Nuxt, Next/React, Astro).
 */
export function extractBoundaryContracts(
  content: string,
  framework: string,
  filePath?: string,
  observations: ReturnType<typeof observeHttpDocument> = observeHttpDocument(content, filePath ?? boundaryDocumentPath(content, framework)),
): BoundaryContract[] {
  const boundaries: (BoundaryContract & { loc: NonNullable<BoundaryContract['loc']> })[] = [];
  const formVarFields = new Map(observations.forms.map(form => [form.name, form.fields.map(field => field.key)]));

  // Inertia form submissions: form.post(...), form.put(...), etc.
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

  // Server Actions (Next.js / Astro actions)
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

  const resolvedMutations = new Set<(typeof observations.mutations)[number]>();
  for (const call of observations.items) {
    const loc = { line: call.line, column: call.column };
    if (call.inertiaRouter) {
      boundaries.push({ boundaryType: 'inertia-router', method: call.method, targetEndpoint: call.rawEndpoint,
        endpointSource: call.inertiaRouter.ziggy ? 'ziggy-route' : call.endpointSource,
        payloadKeys: call.payloadKeys, optimisticUpdate: false, loc,
        backendTargetHint: synthesizeBackendTargetHint(call.method, call.rawEndpoint) });
      continue;
    }
    if (call.clientKind === 'custom' || call.clientKind === 'useQuery') continue;
    if (call.mutation) {
      resolvedMutations.add(call.mutation);
      boundaries.push({ boundaryType: 'tanstack-query', method: call.method, targetEndpoint: call.rawEndpoint,
        endpointSource: call.endpointSource, payloadKeys: call.payloadKeys,
        optimisticUpdate: call.mutation.optimisticUpdate, loc });
      continue;
    }
    const boundaryType = call.clientKind === 'axios' ? 'axios' : call.clientKind === 'fetch' ? 'native-fetch' : 'nuxt-fetch';
    boundaries.push({
      boundaryType,
      method: call.method,
      targetEndpoint: call.rawEndpoint,
      endpointSource: call.endpointSource,
      payloadKeys: call.payloadKeys,
      loc: { line: call.line, column: call.column },
      ...(boundaryType === 'nuxt-fetch' ? { optimisticUpdate: false } : {}),
      ...(boundaryType === 'axios' ? { backendTargetHint: synthesizeBackendTargetHint(call.method, call.endpoint) } : {}),
    });
  }

  for (const mutation of observations.mutations) {
    if (resolvedMutations.has(mutation)) continue;
    boundaries.push({ boundaryType: 'tanstack-query', method: 'UNKNOWN', targetEndpoint: mutation.symbol,
      endpointSource: 'action-symbol', optimisticUpdate: mutation.optimisticUpdate,
      loc: { line: mutation.line, column: mutation.column } });
  }
  return boundaries.sort((a, b) => (a.loc.line - b.loc.line) || ((a.loc.column ?? 1) - (b.loc.column ?? 1)));
}

/**
 * Extracts form and input payload dictionary across template/JSX and script blocks.
 */
export function extractFormContracts(
  content: string,
  templateContent?: string,
  declarations: ReturnType<typeof observeHttpDocument>['forms'] = observeHttpDocument(content, boundaryDocumentPath(content, 'react')).forms
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
  for (const declaration of declarations) {
    for (const { key: k, isFile: isFileField } of declaration.fields) {
      if (!fieldKeySet.has(k)) {
        fieldKeySet.add(k);
        fields.push({
          key: k,
          type: isFileField ? 'file' : 'unknown',
          required: false,
          binding: `${declaration.name}.${k}`
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
