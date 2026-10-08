import type {
  BidirectionalTransportContract,
  BoundaryContract,
  ComponentPropContract,
  EgressTransportContract,
  ErrorHandlingAudit,
  FormContract,
  IngressTransportContract,
  InvalidationGraphContract,
  InvalidationNode,
  SerializationFormat,
  ValidationFieldRule,
  ValidationSchemaContract,
} from '../types';

/**
 * Detects the casing convention of an array of field keys.
 */
export function detectKeyCasing(keys: string[]): 'camelCase' | 'snake_case' | 'mixed' | 'unknown' {
  if (!keys || keys.length === 0) return 'unknown';

  let hasCamel = false;
  let hasSnake = false;

  for (const k of keys) {
    if (k.includes('_')) {
      hasSnake = true;
    } else if (/[a-z][A-Z]/.test(k)) {
      hasCamel = true;
    }
  }

  if (hasCamel && hasSnake) return 'mixed';
  if (hasSnake) return 'snake_case';
  if (hasCamel) return 'camelCase';
  return 'unknown';
}

/**
 * Analyzes outbound network requests (Egress) for payload structure and serialization pitfalls.
 */
export function analyzeEgressTransport(
  boundaryContracts: BoundaryContract[] = [],
  formContracts: FormContract[] = [],
  content = ''
): EgressTransportContract[] {
  const egressList: EgressTransportContract[] = [];

  const isFormMultipart = formContracts.some((f) => f.isMultipart) || /new\s+FormData\b/.test(content);

  for (const boundary of boundaryContracts) {
    const payloadKeys = boundary.payloadKeys || [];
    const casing = detectKeyCasing(payloadKeys);
    const risks: string[] = [];

    let serialization: SerializationFormat = 'json';
    if (isFormMultipart || (boundary.boundaryType === 'inertia-form' && isFormMultipart)) {
      serialization = 'multipart/form-data';
    } else if (boundary.method === 'GET') {
      serialization = 'query-params';
    }

    // Risk 1: Mixed casing in payload keys (e.g. sending user_id and firstName together)
    if (casing === 'mixed') {
      risks.push(`Mixed naming convention in payload (${payloadKeys.join(', ')}). Inconsistent snake_case and camelCase often causes backend DTO validation failure.`);
    }

    // Risk 2: FormData with nested objects
    if (serialization === 'multipart/form-data') {
      for (const k of payloadKeys) {
        if (/options|settings|meta|payload|config|address|details/i.test(k)) {
          risks.push(`Key '${k}' appears to be a nested object in a multipart/form-data payload. Native FormData converts nested objects to "[object Object]" unless manually serialized.`);
        }
      }
    }

    // Risk 3: Empty string vs null in form submissions
    if (boundary.method === 'POST' || boundary.method === 'PUT' || boundary.method === 'PATCH') {
      for (const k of payloadKeys) {
        if (/price|amount|quantity|total|count|date|birth|age|id$/i.test(k)) {
          if (content.includes(`v-model`) || content.includes(`useForm`)) {
            risks.push(`Numeric/temporal field '${k}' in ${boundary.method} payload may transmit empty string ("") instead of null if cleared by user, causing backend type cast validation errors.`);
          }
        }
      }
    }

    egressList.push({
      endpoint: boundary.targetEndpoint,
      method: boundary.method,
      clientKind: boundary.boundaryType,
      serialization,
      payloadKeys,
      casing,
      potentialRisks: risks,
    });
  }

  return egressList;
}

/**
 * Analyzes inbound data ingestion (Ingress) and verifies template/script access patterns
 * against common fullstack traps (Pagination wrapper bypass, Unguarded nullability, etc.).
 */
export function analyzeIngressTransport(
  props: ComponentPropContract[] = [],
  content = ''
): IngressTransportContract[] {
  const ingressList: IngressTransportContract[] = [];

  for (const prop of props) {
    const propName = prop.name;
    const risks: string[] = [];
    const accessedProps: IngressTransportContract['accessedProperties'] = [];

    // Scan for property accesses on propName
    const propAccessRegex = new RegExp(
      `(?:props\\.)?\\b${propName}(\\??\\.)([a-zA-Z0-9_$]+)(?:(\\??\\.)([a-zA-Z0-9_$]+))?`,
      'g'
    );

    let hasDataUnwrap = false;
    let hasDirectIteration = false;
    let hasPaginationMeta = false;

    for (const match of content.matchAll(propAccessRegex)) {
      const firstDot = match[1];
      const firstProp = match[2];
      const secondDot = match[3];
      const secondProp = match[4];

      const fullPath = secondProp ? `${firstProp}.${secondProp}` : firstProp;
      const isGuarded = firstDot === '?.' || secondDot === '?.';

      if (firstProp === 'data') {
        hasDataUnwrap = true;
      }
      if (firstProp === 'links' || firstProp === 'meta' || firstProp === 'current_page' || firstProp === 'total') {
        hasPaginationMeta = true;
      }

      accessedProps.push({
        path: `${propName}.${fullPath}`,
        inferredType: secondProp ? 'unknown' : (firstProp === 'data' ? 'Array' : 'any'),
        hasNullGuard: isGuarded,
      });

      // Check unguarded deep access
      if (secondProp && !isGuarded) {
        risks.push(`Unguarded nested access '${propName}.${fullPath}' lacks optional chaining (?.). If backend returns null for relation '${firstProp}', this will trigger an unhandled TypeError.`);
      }
    }

    // Check direct iteration on paginated prop
    const directIterRegex = new RegExp(
      `v-for=['"][^'"]*\\bin\\s+${propName}(?!\\.data)\\b|\\b${propName}\\.map\\(|\\b${propName}\\.forEach\\(`,
      'i'
    );
    if (directIterRegex.test(content)) {
      hasDirectIteration = true;
    }

    const isScalarPrimitive = Boolean(
      prop.type &&
      /^(?:string|number|boolean|symbol|bigint|String|Number|Boolean)$/i.test(prop.type.trim())
    );

    let expectedShape: IngressTransportContract['expectedShape'] =
      isScalarPrimitive && accessedProps.length === 0 ? 'primitive' : 'entity-object';
    if (hasDataUnwrap || hasPaginationMeta) {
      expectedShape = 'paginated-collection';
    } else if (hasDirectIteration || prop.type?.includes('[]') || prop.type?.includes('Array')) {
      expectedShape = 'array';
    }

    // Risk 1: Pagination trap (accessing prop.map directly when prop is a paginated collection)
    if (expectedShape === 'paginated-collection' && hasDirectIteration) {
      risks.push(`CRITICAL Pagination Trap: '${propName}' contains pagination metadata (.data / .links), but is iterated directly ('${propName}.map' or 'v-for in ${propName}'). Will crash with "${propName}.map is not a function" when backend returns a paginated Resource collection.`);
    }

    // Deduplicate risks
    const uniqueRisks = Array.from(new Set(risks));

    ingressList.push({
      source: 'page-props',
      rootPropName: propName,
      expectedShape,
      accessedProperties: accessedProps,
      potentialRisks: uniqueRisks,
    });
  }

  return ingressList;
}

/**
 * Extracts validation schemas defined or imported in component (Zod, Valibot, TypeScript interfaces).
 */
export function extractValidationSchemas(content: string): ValidationSchemaContract[] {
  const schemas: ValidationSchemaContract[] = [];

  // 1. Zod object scanner: const [Name] = z.object({ ... })
  const zodSchemaRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*z\.object\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  for (const match of content.matchAll(zodSchemaRegex)) {
    const name = match[1];
    const body = match[2];
    const fields: ValidationFieldRule[] = [];

    // Parse each line/property
    const fieldLines = body.split('\n');
    for (const fl of fieldLines) {
      const fieldMatch = fl.match(/^\s*([A-Za-z0-9_$]+)\s*:\s*z\.([a-zA-Z0-9_$.()]+)/);
      if (fieldMatch) {
        const field = fieldMatch[1];
        const chain = fieldMatch[2];

        let baseType = 'unknown';
        if (chain.startsWith('string')) baseType = 'string';
        else if (chain.startsWith('number')) baseType = 'number';
        else if (chain.startsWith('boolean')) baseType = 'boolean';
        else if (chain.startsWith('date')) baseType = 'date';
        else if (chain.startsWith('array')) baseType = 'array';
        else if (chain.startsWith('object')) baseType = 'object';

        const isOptional = chain.includes('.optional(');
        const isNullable = chain.includes('.nullable(');

        const constraints: string[] = [];
        const constraintMatches = chain.matchAll(/\.([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/g);
        for (const cm of constraintMatches) {
          const fn = cm[1];
          const arg = cm[2];
          if (fn !== 'optional' && fn !== 'nullable' && fn !== baseType) {
            constraints.push(arg ? `${fn}(${arg})` : `${fn}()`);
          }
        }

        fields.push({
          field,
          baseType,
          isOptional,
          isNullable,
          constraints,
        });
      }
    }

    if (fields.length > 0) {
      schemas.push({
        name,
        schemaLibrary: 'zod',
        fields,
      });
    }
  }

  // 2. TypeScript interface payload scanner: interface [Name]Payload { ... }
  const tsInterfaceRegex = /interface\s+([A-Za-z0-9_$]+(?:Payload|Request|DTO|Input))\s*\{([\s\S]*?)\}/g;
  for (const match of content.matchAll(tsInterfaceRegex)) {
    const name = match[1];
    const body = match[2];
    const fields: ValidationFieldRule[] = [];

    const fieldLines = body.split('\n');
    for (const fl of fieldLines) {
      const fieldMatch = fl.match(/^\s*([A-Za-z0-9_$]+)(\??)\s*:\s*([^;,\n]+)/);
      if (fieldMatch) {
        const field = fieldMatch[1];
        const isOptional = Boolean(fieldMatch[2]);
        const rawType = fieldMatch[3].trim();
        const isNullable = rawType.includes('null');

        fields.push({
          field,
          baseType: rawType,
          isOptional,
          isNullable,
          constraints: [],
        });
      }
    }

    if (fields.length > 0) {
      schemas.push({
        name,
        schemaLibrary: 'typescript-interface',
        fields,
      });
    }
  }

  return schemas;
}

/**
 * Audits error handling bindings to detect unhandled 422 validation rejections (Silent Failures).
 */
export function auditErrorHandling(
  content: string,
  egress: EgressTransportContract[]
): ErrorHandlingAudit {
  const errorSources = new Set<string>();
  const boundErrorFields = new Set<string>();

  // Check Inertia useForm errors
  if (/\b(?:form\.)?errors\b/.test(content)) {
    errorSources.add('form.errors');
  }
  // Check onError callbacks
  if (/\bonError\s*[:(]/.test(content)) {
    errorSources.add('onError');
  }
  // Check isError or error states
  if (/\b(?:isError|hasError|error)\b/.test(content)) {
    errorSources.add('isError');
  }

  // Scan bound error fields in template and JSX:
  // e.g. form.errors.email, errors.email, <InputError :message="form.errors.email"
  const errorFieldRegex = /(?:form\.)?errors(?:\?\.|\.)([a-zA-Z0-9_$]+)|(?:<InputError|<ErrorMessage)[^>]*for=['"]([a-zA-Z0-9_$]+)['"]/g;
  for (const m of content.matchAll(errorFieldRegex)) {
    const field = m[1] || m[2];
    if (field && field !== 'value' && field !== 'length') {
      boundErrorFields.add(field);
    }
  }

  // Collect all submitted payload keys from mutating methods (POST, PUT, PATCH, DELETE)
  const mutationPayloadKeys = new Set<string>();
  for (const e of egress) {
    if (e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH' || e.method === 'DELETE') {
      for (const k of e.payloadKeys) {
        mutationPayloadKeys.add(k);
      }
    }
  }

  const unhandledPayloadKeys: string[] = [];
  for (const k of mutationPayloadKeys) {
    if (!boundErrorFields.has(k)) {
      unhandledPayloadKeys.push(k);
    }
  }

  return {
    hasErrorBinding: errorSources.size > 0 || boundErrorFields.size > 0,
    errorSources: Array.from(errorSources),
    boundErrorFields: Array.from(boundErrorFields),
    unhandledPayloadKeys,
  };
}

/**
 * Extracts cache invalidation calls to map the Mutation ➔ Invalidation ➔ Query lifecycle.
 */
export function extractInvalidationGraph(
  content: string,
  egress: EgressTransportContract[]
): InvalidationGraphContract {
  const invalidations: InvalidationNode[] = [];
  const lines = content.split('\n');

  function getLine(idx: number): number {
    let cur = 0;
    for (let i = 0; i < lines.length; i++) {
      if (cur + lines[i].length + 1 > idx) return i + 1;
      cur += lines[i].length + 1;
    }
    return 1;
  }

  // 1. TanStack Query: queryClient.invalidateQueries(...)
  const tanstackRegex = /\b(?:queryClient|qc)\.invalidateQueries\s*\(\s*\{[\s\S]*?queryKey\s*:\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(tanstackRegex)) {
    invalidations.push({
      line: getLine(m.index || 0),
      mechanism: 'tanstack-invalidate',
      targetKeyOrUrl: m[1].replace(/\s+/g, ' '),
      triggerAction: 'onSuccess / mutation',
    });
  }

  // 2. SWR: mutate(url)
  const swrRegex = /\bmutate\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  for (const m of content.matchAll(swrRegex)) {
    invalidations.push({
      line: getLine(m.index || 0),
      mechanism: 'swr-mutate',
      targetKeyOrUrl: m[1],
      triggerAction: 'mutation callback',
    });
  }

  // 3. Inertia: router.reload({ only: [...] })
  const inertiaReloadRegex = /\brouter\.reload\s*\(\s*\{[\s\S]*?only\s*:\s*(\[[^\]]+\])/g;
  for (const m of content.matchAll(inertiaReloadRegex)) {
    invalidations.push({
      line: getLine(m.index || 0),
      mechanism: 'inertia-reload',
      targetKeyOrUrl: m[1].replace(/\s+/g, ' '),
      triggerAction: 'partial reload',
    });
  }

  // Identify dangling mutations (POST, PUT, DELETE with no invalidation in component)
  const mutatingCalls = egress.filter(
    (e) => e.method === 'POST' || e.method === 'PUT' || e.method === 'DELETE'
  );
  const hasDanglingMutation = mutatingCalls.length > 0 && invalidations.length === 0;
  const danglingMutations = hasDanglingMutation ? mutatingCalls.map((e) => `[${e.method}] ${e.endpoint}`) : [];

  return {
    invalidations,
    hasDanglingMutation,
    danglingMutations,
  };
}

/**
 * Universal facade: analyzes both egress and ingress transportation contracts and synthesizes
 * cross-boundary transport risk diagnostics (Level 1 + Level 2).
 */
export function analyzeBidirectionalTransport(
  boundaryContracts: BoundaryContract[] = [],
  formContracts: FormContract[] = [],
  props: ComponentPropContract[] = [],
  content = ''
): BidirectionalTransportContract {
  const egress = analyzeEgressTransport(boundaryContracts, formContracts, content);
  const ingress = analyzeIngressTransport(props, content);
  const validationSchemas = extractValidationSchemas(content);
  const errorHandling = auditErrorHandling(content, egress);
  const invalidationGraph = extractInvalidationGraph(content, egress);

  const transportRisksSet = new Set<string>();

  // Egress risks
  for (const e of egress) {
    for (const r of e.potentialRisks) {
      transportRisksSet.add(`[EGRESS ➔ BACKEND] ${r}`);
    }
  }

  // Ingress risks
  for (const i of ingress) {
    for (const r of i.potentialRisks) {
      transportRisksSet.add(`[INGRESS ➔ FRONTEND] ${r}`);
    }
  }

  // Level 2: Unhandled 422 validation error risks
  if (errorHandling.unhandledPayloadKeys.length > 0 && errorHandling.hasErrorBinding) {
    transportRisksSet.add(
      `[UNHANDLED 422 ERROR ENVELOPE] Payload keys (${errorHandling.unhandledPayloadKeys.join(', ')}) lack UI error message bindings. Backend 422 validation rejections for these fields will fail silently without user feedback.`
    );
  }

  // Level 2: Dangling mutation risks (Stale UI cache)
  if (invalidationGraph.hasDanglingMutation) {
    transportRisksSet.add(
      `[STALE CACHE HAZARD] Component executes mutation(s) ${invalidationGraph.danglingMutations.join(', ')} but no cache invalidation (queryClient.invalidateQueries, mutate, router.reload) was found. UI risks displaying stale data.`
    );
  }

  return {
    egress,
    ingress,
    validationSchemas: validationSchemas.length > 0 ? validationSchemas : undefined,
    errorHandling,
    invalidationGraph: invalidationGraph.invalidations.length > 0 || invalidationGraph.hasDanglingMutation ? invalidationGraph : undefined,
    transportRisks: Array.from(transportRisksSet),
  };
}

