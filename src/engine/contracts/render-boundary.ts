import { parseTypeScript } from '../source-parser';
import { moduleDirective } from '../parsers/ts-syntax';
import { reactBindings } from '../parsers/react-bindings';
import { jsxDomEventName } from '../parsers/jsx-events';
import { isOwnedNextAppFile } from '../project-ownership';
import { join } from 'node:path';
import ts from 'typescript';
import { parse as parseDom, NodeTypes } from '@vue/compiler-dom';
import { parseSfc } from '../splitter';
import { parseAstro, parseAstroAttributes } from '../astro-sfc';
import { astroOpeningTags } from '../astro-template';
import type { BoundaryViolation, FrontendFramework, RenderBoundaryInfo, ProjectOwnershipInfo } from '../../types';

export function extractRenderBoundary(
  filePath: string,
  content: string,
  framework: FrontendFramework | 'vue-composable',
  projectContext?: ProjectOwnershipInfo
): RenderBoundaryInfo {
  const normPath = filePath.replace(/\\/g, '/');
  const violations: BoundaryViolation[] = [];

  if (framework === 'vue-composable') {
    return {
      boundary: 'isomorphic',
      isClientHydrated: true,
    };
  }

  if (framework === 'react' || framework === 'next') {
    // 1. Check for 'use client' directive
    if (moduleDirective(content, 'use client')) {
      return {
        boundary: 'client-component',
        directive: 'use client',
        isClientHydrated: true,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'directive-node',
          reason: "'use client' directive found at top of file",
        },
      };
    }

    // 2. Check for 'use server' directive
    if (moduleDirective(content, 'use server')) {
      return {
        boundary: 'server-action',
        directive: 'use server',
        isClientHydrated: false,
        evidence: {
          basis: 'source',
          resolution: 'resolved',
          method: 'directive-node',
          reason: "'use server' directive found at top of file",
        },
      };
    }

    // 3. Next.js App router defaults to React Server Component (RSC)
    const inApp = projectContext ? isOwnedNextAppFile(filePath, projectContext)
      : normPath.startsWith('app/') || normPath.includes('/app/');
    if (framework === 'next' && inApp) {
      // Check for client-only hooks in RSC
      const sourceFile = parseTypeScript(filePath, content, ts.ScriptKind.TSX);
      const bindings = reactBindings(sourceFile);
      const clientApis = new Set(['useState', 'useEffect', 'useReducer', 'useRef', 'useLayoutEffect',
        'useTransition', 'useDeferredValue', 'useActionState', 'useOptimistic', 'createContext', 'useContext']);
      const observedHooks = new Set<string>();
      const observedEvents = new Set<string>();
      function visitHook(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const api = bindings.api(node.expression);
          if (api && clientApis.has(api)) observedHooks.add(api);
        }
        const event = jsxDomEventName(node);
        if (event) observedEvents.add(event);
        ts.forEachChild(node, visitHook);
      }
      visitHook(sourceFile);
      const clientHooks = [...observedHooks];

      if (clientHooks.length > 0) {
        violations.push({
          code: 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT',
          severity: 'error',
          message: `React Server Component uses client-only hook(s): ${clientHooks.join(', ')}.`,
          hint: "Add 'use client' directive at the top of the file to mark it as a Client Component.",
        });
      }

      // Check for DOM event handlers attached in JSX
      const eventHandlers = [...observedEvents];

      if (eventHandlers.length > 0) {
        violations.push({
          code: 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT',
          severity: 'error',
          message: `React Server Component attaches client DOM event handler(s): ${eventHandlers.join(', ')}.`,
          hint: "Event handlers cannot be passed in Server Components. Add 'use client' or move the handler into a Client Component leaf.",
        });
      }

      return {
        boundary: 'server-component',
        isClientHydrated: false,
        violations: violations.length > 0 ? violations : undefined,
        evidence: {
          basis: 'source',
          resolution: projectContext ? 'resolved' : 'candidate',
          method: 'app-router-convention',
          reason: projectContext ? 'Source is inside the observed Next owner app directory without a client directive'
            : 'App path convention without captured project ownership; application root and caller context are unverified',
        },
      };
    }

    // Next shared modules require caller context to determine their render environment.
    if (framework === 'next' || normPath.includes('/components/') || normPath.includes('/ui/')) {
      return {
        boundary: 'isomorphic',
        isClientHydrated: true,
        evidence: {
          basis: 'derived',
          resolution: 'candidate',
          method: 'neutral-component',
          reason: framework === 'next'
            ? 'Next module outside observed app convention; caller server/client context is unverified'
            : 'Component without explicit directive in shared component directory',
        },
      };
    }

    // Standard client component in Vite/CRA/Next Pages router
    return {
      boundary: 'client-component',
      isClientHydrated: true,
      evidence: {
        basis: 'derived',
        resolution: 'candidate',
        method: 'framework-default',
        reason: 'React client-side default candidate; application bundler, SSR and caller context are unverified',
      },
    };
  }

  if (framework === 'vue' || framework === 'nuxt') {
    if (framework === 'nuxt' && normPath.endsWith('.client.vue')) {
      return {
        boundary: 'client-only',
        directive: '.client.vue',
        isClientHydrated: true,
        evidence: { basis: 'derived', resolution: 'candidate', method: 'nuxt-filename-convention',
          reason: 'Nuxt client suffix observed; registration and runtime configuration are unverified' },
      };
    }
    if (framework === 'nuxt' && normPath.endsWith('.server.vue')) {
      return {
        boundary: 'server-only',
        directive: '.server.vue',
        isClientHydrated: false,
        evidence: { basis: 'derived', resolution: 'candidate', method: 'nuxt-filename-convention',
          reason: 'Nuxt server suffix observed; paired client components, island settings and registration are unverified' },
      };
    }
    const vueTemplate = parseSfc(content, filePath).template;
    let hasClientOnly = false;
    if (framework === 'nuxt' && vueTemplate) {
      try {
        const ast = parseDom(vueTemplate.content);
        const visit = (node: any): void => {
          if (node.type === NodeTypes.ELEMENT && ['ClientOnly', 'client-only'].includes(node.tag)) hasClientOnly = true;
          for (const child of node.children ?? []) visit(child);
        };
        visit(ast);
      } catch { /* Invalid templates do not establish a ClientOnly wrapper. */ }
    }
    if (hasClientOnly) {
      return {
        boundary: 'isomorphic',
        directive: '<ClientOnly>',
        isClientHydrated: true,
        evidence: { basis: 'source', resolution: 'candidate', method: 'nuxt-template-wrapper',
          reason: 'Local ClientOnly tag observed in Nuxt; binding identity and descendant boundaries are unverified' },
      };
    }

    return {
      boundary: 'isomorphic',
      isClientHydrated: true,
      evidence: { basis: 'derived', resolution: 'candidate', method: 'framework-default',
        reason: 'Vue syntax does not establish application SSR/hydration configuration' },
    };
  }

  if (framework === 'astro') {
    const template = parseAstro(content, filePath).template;
    const tags = astroOpeningTags(template?.content ?? '').filter(tag => /^[A-Z]/.test(tag.name));
    let directive: string | undefined;
    const interactiveMatch: string[] = [];
    for (const tag of tags) {
      const attrs = parseAstroAttributes(tag.attributes);
      const hydration = Object.keys(attrs).find(name => /^client:(load|visible|idle|media|only)$/.test(name));
      if (hydration) directive ??= attrs[hydration] === true ? hydration : `${hydration}=${attrs[hydration]}`;
      else if (/(Modal|Dialog|Dropdown|Drawer|Menu|Select|Button|Tabs|Form|Input|Counter|Carousel|Accordion)$/.test(tag.name)) {
        if (!interactiveMatch.includes(tag.name)) interactiveMatch.push(tag.name);
      }
    }
    if (interactiveMatch.length > 0) {
      violations.push({
        code: 'ASTRO_UNHYDRATED_INTERACTIVE_ISLAND',
        severity: 'warning',
        message: `Potentially interactive component(s) (${interactiveMatch.slice(0, 3).join(', ')}) rendered without hydration directive (name-based candidates).`,
        hint: "Add client:load or client:visible if this component requires client-side interactivity, otherwise it will render as inert static HTML.",
      });
    }

    return {
      boundary: directive ? 'astro-island' : 'astro-static',
      ...(directive ? { directive } : {}),
      isClientHydrated: Boolean(directive),
      violations: violations.length > 0 ? violations : undefined,
      evidence: { basis: 'source', resolution: 'candidate', method: 'astro-template-convention',
        reason: directive ? 'Local component hydration directive observed; component compatibility and runtime behavior are unverified'
          : 'Astro component default without observed island directive; embedded scripts and runtime interactivity are not evaluated' },
    };
  }

  return {
    boundary: 'unknown',
    isClientHydrated: false,
    evidence: { basis: 'heuristic', resolution: 'unresolved', method: 'boundary-not-established',
      reason: 'Component syntax alone does not establish SSR, hydration or a server/client boundary' },
  };
}
