import type { BackendTargetHint } from '../../types';

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function toPascalCase(str: string): string {
  if (!str) return '';
  return str
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join('');
}

function singularize(word: string): string {
  if (!word) return '';
  const lower = word.toLowerCase();
  if (
    lower === 'checkout' ||
    lower === 'status' ||
    lower === 'news' ||
    lower === 'business' ||
    lower === 'process'
  ) {
    return word;
  }
  if (lower.endsWith('ies') && lower.length > 4) {
    return word.slice(0, -3) + 'y';
  }
  if (
    lower.endsWith('es') &&
    (lower.endsWith('xes') || lower.endsWith('shes') || lower.endsWith('ches')) &&
    lower.length > 3
  ) {
    return word.slice(0, -2);
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Synthesizes a bridge hint for downstream backend analysis tools or agent vertical-slice tracers.
 * Transforms frontend outbound endpoints (e.g. POST /api/v1/checkout or route('orders.store'))
 * into backend controller, action, and route intent candidates.
 */
export function synthesizeBackendTargetHint(
  method: string,
  endpoint: string
): BackendTargetHint {
  const normMethod = (method || 'GET').toUpperCase();
  const trimmedEndpoint = endpoint.trim();

  // 1. Detect Ziggy named routes e.g. route('checkout.store') or 'orders.index'
  const ziggyMatch = trimmedEndpoint.match(/^(?:route\s*\(\s*)?['"]?([a-zA-Z0-9_.-]+)['"]?\s*\)?$/);
  const isNamedRoute = Boolean(
    ziggyMatch &&
    !trimmedEndpoint.startsWith('/') &&
    !trimmedEndpoint.startsWith('http') &&
    ziggyMatch[1].includes('.')
  );

  if (isNamedRoute && ziggyMatch) {
    const namedRoute = ziggyMatch[1];
    const parts = namedRoute.split('.');
    const resource = parts[0];
    const action = parts[parts.length - 1];
    const entityName = capitalize(singularize(resource));
    const pascalEntity = toPascalCase(singularize(resource));
    const targetIntent = `${normMethod} ${namedRoute}`;

    const suggestedSymbols = Array.from(
      new Set([
        `${entityName}Controller`,
        `${entityName}Controller@${action}`,
        `${entityName}Action`,
        `${entityName}Service`,
        ...(pascalEntity && pascalEntity !== entityName
          ? [
              `${pascalEntity}Controller`,
              `${pascalEntity}Controller@${action}`,
              `${pascalEntity}Action`,
              `${pascalEntity}Service`,
            ]
          : []),
        `${pascalEntity || entityName}Handler`,
      ])
    );

    return {
      targetIntent,
      routePattern: namedRoute,
      namedRoute,
      suggestedSymbols,
      isHeuristic: true,
      disclaimer: 'Pure Naming Convention Heuristic; verify actual route mapping in routes/web.php or routes/api.php',
    };
  }

  // 2. Normalize REST path
  // Strip protocol, host, and query params
  const cleanPath = trimmedEndpoint
    .replace(/^https?:\/\/[^/]+/i, '')
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  // Strip common prefix like api/v1/ or api/
  const strippedPath = cleanPath.replace(/^api\/(?:v[0-9]+\/)?/i, '');
  const segments = strippedPath.split('/').filter(Boolean);

  // Extract non-parameter resource segments (e.g. 'users', 'posts', 'checkout')
  const resourceSegments = segments.filter((s) => !s.startsWith(':') && !s.startsWith('{'));
  const lastResource = resourceSegments[resourceSegments.length - 1] || 'Default';
  const hasParamAtEnd =
    segments[segments.length - 1]?.startsWith(':') ||
    segments[segments.length - 1]?.startsWith('{');

  const entityName = capitalize(singularize(lastResource));
  const pascalEntity = toPascalCase(singularize(lastResource));

  // Determine standard REST action from HTTP method & path shape
  let suggestedAction = 'handle';
  const lowerResource = lastResource.toLowerCase();
  const knownActionVerbs = [
    'checkout',
    'login',
    'logout',
    'register',
    'verify',
    'upload',
    'search',
    'export',
    'import',
    'cancel',
    'process',
    'sync',
    'approve',
    'reject',
    'activate',
    'deactivate',
    'archive',
    'restore',
    'publish',
    'submit',
  ];

  if (knownActionVerbs.includes(lowerResource)) {
    suggestedAction = lowerResource;
  } else if (normMethod === 'GET') {
    suggestedAction = hasParamAtEnd ? 'show' : 'index';
  } else if (normMethod === 'POST') {
    suggestedAction = 'store';
  } else if (normMethod === 'PUT' || normMethod === 'PATCH') {
    suggestedAction = 'update';
  } else if (normMethod === 'DELETE') {
    suggestedAction = 'destroy';
  }

  // If the trailing segment is an action verb preceded by a parent resource (e.g. /api/orders/:id/approve),
  // include parent resource controller/service/handler symbols alongside the primary symbols.
  const parentResource =
    knownActionVerbs.includes(lowerResource) && resourceSegments.length >= 2
      ? resourceSegments[resourceSegments.length - 2]
      : undefined;
  const parentPascal = parentResource ? toPascalCase(singularize(parentResource)) : undefined;

  const suggestedSymbols = Array.from(
    new Set([
      `${entityName}Controller`,
      `${entityName}Controller@${suggestedAction}`,
      `${entityName}Action`,
      `${entityName}Service`,
      ...(pascalEntity && pascalEntity !== entityName
        ? [
            `${pascalEntity}Controller`,
            `${pascalEntity}Controller@${suggestedAction}`,
            `${pascalEntity}Action`,
            `${pascalEntity}Service`,
          ]
        : []),
      ...(parentPascal && parentPascal !== pascalEntity
        ? [
            `${parentPascal}Controller`,
            `${parentPascal}Controller@${suggestedAction}`,
            `${parentPascal}Service`,
            `${parentPascal}Handler`,
          ]
        : []),
      `${pascalEntity || entityName}Handler`,
    ])
  );

  const targetIntent = `${normMethod} ${cleanPath || trimmedEndpoint}`;

  return {
    targetIntent,
    routePattern: cleanPath || trimmedEndpoint,
    suggestedSymbols,
    isHeuristic: true,
    disclaimer: 'Pure Naming Convention Heuristic; verify actual route mapping in routes/web.php or routes/api.php',
  };
}
