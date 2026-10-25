import ts from 'typescript';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

const FORBIDDEN_SERVER_MODULES = new Set([
  'fs',
  'node:fs',
  'node:fs/promises',
  'path',
  'node:path',
  'pg',
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  'mysql2',
  'server-only',
  'crypto',
  'node:crypto',
]);

function containsJsx(node: ts.Node): boolean {
  let found = false;
  function walk(n: ts.Node) {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return found;
}

function hasUseServerDirective(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (node.body && ts.isBlock(node.body)) {
    for (const stmt of node.body.statements) {
      if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression) && stmt.expression.text === 'use server') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Next.js Canonical Pattern Rules:
 * 1. next/no-use-client-at-page-root (warning)
 * 2. next/error-boundary-must-be-client (error)
 * 3. next/no-async-client-component (error)
 * 4. next/server-secret-in-client (error)
 * 5. next/next15-sync-dynamic-apis (warning)
 * 6. next/no-self-api-fetch-in-rsc (warning)
 * 7. next/rsc-event-handler (error)
 */
export async function checkNextRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];
  const normPath = snapshot.file.replace(/\\/g, '/');

  const hasUseClientDirective = /^\s*['"]use client['"]/m.test(content);
  const isAppRouterFile = /(?:^|\/)app\//.test(normPath);
  const isAppRouterRoot = /(?:^|\/)app\/(?:.*\/)?(?:page|layout)\.(?:tsx|jsx|js|ts)$/.test(normPath);
  const isErrorBoundary = /(?:^|\/)app\/(?:.*\/)?(?:global-)?error\.(?:tsx|jsx|js|ts)$/.test(normPath);

  // 1. next/no-use-client-at-page-root
  if (isAppRouterRoot && hasUseClientDirective) {
    const match = content.match(/^(\s*['"]use client['"])/m);
    const startOffset = match ? (match.index || 0) : 0;
    const endOffset = startOffset + (match ? match[0].length : 12);

    diagnostics.push(
      createDiagnostic({
        ruleId: 'next/no-use-client-at-page-root',
        framework: 'next',
        category: 'architecture',
        severity: 'warning',
        snapshot,
        content,
        startOffset,
        endOffset,
        smellTitle: "'use client' Directive Placed at Root Page or Layout",
        smellExplanation:
          "Placing 'use client' at the root of a page or layout converts the entire route sub-tree into a Client Component bundle. This eliminates server-side async data fetching, increases bundle size, and harms LCP/SEO.",
        canonSummary:
          'Remove \'use client\' from page/layout root and extract interactive leaves to dedicated client components.',
        canonRationale:
          'Next.js App Router performs optimally when pages remain async Server Components that stream data down, passing serialized props to focused Client Component leaves.',
        canonicalCode:
          "// app/users/page.tsx (Server Component)\nimport { UserTable } from '@/components/UserTable'; // 'use client' inside UserTable\n\nexport default async function UsersPage() {\n  const users = await db.user.findMany();\n  return <UserTable users={users} />;\n}",
        referenceDoc: 'https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns',
      })
    );
  }

  // 2. next/error-boundary-must-be-client
  if (isErrorBoundary && !hasUseClientDirective) {
    diagnostics.push(
      createDiagnostic({
        ruleId: 'next/error-boundary-must-be-client',
        framework: 'next',
        category: 'boundary',
        severity: 'error',
        snapshot,
        content,
        startOffset: 0,
        endOffset: Math.min(content.length, 30),
        smellTitle: "Next.js Error Boundary Missing 'use client' Directive",
        smellExplanation:
          "In Next.js App Router, error boundaries (error.tsx and global-error.tsx) must be Client Components to catch client-side runtime errors and invoke the reset() function.",
        canonSummary: "Add 'use client' directive at the top of error boundary files.",
        canonRationale:
          "Next.js error boundaries render fallback UI when unhandled exceptions occur. Without 'use client', Next.js build or runtime will fail.",
        canonicalCode:
          "'use client';\n\nexport default function ErrorBoundary({\n  error,\n  reset,\n}: {\n  error: Error & { digest?: string };\n  reset: () => void;\n}) {\n  return (\n    <div>\n      <h2>Something went wrong!</h2>\n      <button onClick={() => reset()}>Try again</button>\n    </div>\n  );\n}",
        referenceDoc: 'https://nextjs.org/docs/app/building-your-application/routing/error-handling',
      })
    );
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(snapshot.file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return diagnostics;
  }

  const isNext15 = options?.majorVersion !== undefined ? options.majorVersion >= 15 : true;

  function visit(node: ts.Node) {
    // 3. next/no-async-client-component
    if (hasUseClientDirective) {
      if (ts.isFunctionDeclaration(node)) {
        const isAsync = Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
        const isExported = Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        const isDefault = Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
        const name = node.name?.text;
        const isComponent = (name && /^[A-Z]/.test(name)) || (isDefault && containsJsx(node));

        if (isAsync && isComponent && !hasUseServerDirective(node)) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'next/no-async-client-component',
              framework: 'next',
              category: 'syntax',
              severity: 'error',
              snapshot,
              content,
              startOffset: node.getStart(sourceFile),
              endOffset: node.name ? node.name.getEnd() : node.getStart(sourceFile) + 20,
              smellTitle: 'Async Client Component Declared',
              smellExplanation:
                'Client Components cannot be async functions. Async client components cause infinite re-renders or runtime hydration failures in React.',
              canonSummary:
                'Convert client component to a synchronous function and use React.use(promise) or client fetching hooks.',
              canonRationale:
                "Async components are only supported in Server Components. For client-side asynchronous data unwrapping in React 19, use the 'use' hook or TanStack Query.",
              canonicalCode:
                "'use client';\n\nimport { use } from 'react';\n\nexport default function UserProfile({ dataPromise }: { dataPromise: Promise<UserData> }) {\n  const data = use(dataPromise);\n  return <div>{data.name}</div>;\n}",
              referenceDoc: 'https://nextjs.org/docs/app/building-your-application/rendering/client-components',
            })
          );
        }
      } else if (ts.isVariableStatement(node)) {
        const isExported = Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        for (const decl of node.declarationList.declarations) {
          const name = decl.name.getText(sourceFile);
          if (/^[A-Z]/.test(name) && decl.initializer) {
            let init = decl.initializer;
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (
              (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
              init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
              !hasUseServerDirective(init) &&
              containsJsx(init)
            ) {
              diagnostics.push(
                createDiagnostic({
                  ruleId: 'next/no-async-client-component',
                  framework: 'next',
                  category: 'syntax',
                  severity: 'error',
                  snapshot,
                  content,
                  startOffset: decl.getStart(sourceFile),
                  endOffset: decl.name.getEnd(),
                  smellTitle: 'Async Client Component Declared',
                  smellExplanation:
                    'Client Components cannot be async functions. Async client components cause infinite re-renders or runtime hydration failures in React.',
                  canonSummary:
                    'Convert client component to a synchronous function and use React.use(promise) or client fetching hooks.',
                  canonRationale:
                    "Async components are only supported in Server Components. For client-side asynchronous data unwrapping in React 19, use the 'use' hook or TanStack Query.",
                  canonicalCode:
                    "'use client';\n\nimport { use } from 'react';\n\nexport default function UserProfile({ dataPromise }: { dataPromise: Promise<UserData> }) {\n  const data = use(dataPromise);\n  return <div>{data.name}</div>;\n}",
                  referenceDoc: 'https://nextjs.org/docs/app/building-your-application/rendering/client-components',
                })
              );
            }
          }
        }
      }
    }

    // 4. next/server-secret-in-client
    if (hasUseClientDirective) {
      // 4a. Server module import in client
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const modName = node.moduleSpecifier.text;
        if (FORBIDDEN_SERVER_MODULES.has(modName) || (modName.startsWith('node:') && modName !== 'node:url')) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'next/server-secret-in-client',
              framework: 'next',
              category: 'security',
              severity: 'error',
              snapshot,
              content,
              startOffset: node.getStart(sourceFile),
              endOffset: node.getEnd(),
              smellTitle: 'Server Module Imported into Client Component',
              smellExplanation: `Client Components must not import server backend module '${modName}'. Doing so leaks server logic and causes client bundler failure.`,
              canonSummary:
                'Move database and server module calls to Server Components, Route Handlers, or Server Actions.',
              canonRationale:
                'Server-only modules execute strictly in Node.js/Edge runtime environments and must never be exposed to the browser bundle.',
              canonicalCode:
                "// app/actions/data.ts\n'use server';\n\nimport { db } from '@/lib/db';\n\nexport async function loadData() {\n  return db.query(...);\n}",
              referenceDoc:
                'https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#keeping-server-only-code-out-of-the-client-environment',
            })
          );
        }
      }

      // 4b. Secret environment variable access in client
      if (ts.isPropertyAccessExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(sourceFile) === 'process' &&
          node.expression.name.text === 'env'
        ) {
          const varName = node.name.text;
          if (!varName.startsWith('NEXT_PUBLIC_') && !['NODE_ENV', 'TZ'].includes(varName)) {
            diagnostics.push(
              createDiagnostic({
                ruleId: 'next/server-secret-in-client',
                framework: 'next',
                category: 'security',
                severity: 'error',
                snapshot,
                content,
                startOffset: node.getStart(sourceFile),
                endOffset: node.getEnd(),
                smellTitle: 'Server Secret Environment Variable Accessed in Client Component',
                smellExplanation: `Environment variable 'process.env.${varName}' without NEXT_PUBLIC_ prefix is accessed in a Client Component. It evaluates to undefined in the browser bundle and risks leaking secret references.`,
                canonSummary:
                  `Prefix variable with NEXT_PUBLIC_${varName} if public, or move secret access to a Server Action / Route Handler.`,
                canonRationale:
                  'Next.js bundler only inlines environment variables prefixed with NEXT_PUBLIC_ into client JavaScript bundles.',
                canonicalCode:
                  "// Accessing server secret inside Server Action\n'use server';\n\nexport async function getSecureData() {\n  const secret = process.env.API_SECRET;\n  return fetchSecret(secret);\n}",
                referenceDoc: 'https://nextjs.org/docs/app/building-your-application/configuring/environment-variables',
              })
            );
          }
        }
      }
    }

    // 5. next/next15-sync-dynamic-apis
    if (isNext15) {
      // 5a. cookies() or headers() called synchronously
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fnName = node.expression.text;
        if (fnName === 'cookies' || fnName === 'headers') {
          let isAwaited = false;
          let current: ts.Node = node;
          while (current.parent) {
            if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
              isAwaited = true;
              break;
            }
            if (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
              current = current.parent;
              continue;
            }
            if (ts.isCallExpression(current.parent) && current.parent.expression === current) {
              current = current.parent;
              continue;
            }
            break;
          }

          if (!isAwaited) {
            diagnostics.push(
              createDiagnostic({
                ruleId: 'next/next15-sync-dynamic-apis',
                framework: 'next',
                category: 'architecture',
                severity: 'warning',
                snapshot,
                content,
                startOffset: node.getStart(sourceFile),
                endOffset: node.getEnd(),
                smellTitle: `Synchronous Call to Next.js 15 Asynchronous API '${fnName}()'`,
                smellExplanation: `In Next.js 15, '${fnName}()' is an asynchronous function returning a Promise. Calling it synchronously is deprecated and will fail in future releases.`,
                canonSummary: `Await '${fnName}()' before reading properties: const cookieStore = await ${fnName}();`,
                canonRationale:
                  'Next.js 15 unifies request-time APIs into Promises to enable streaming optimizations and Partial Prerendering (PPR).',
                canonicalCode: `const cookieStore = await ${fnName}();\nconst token = cookieStore.get('token');`,
                referenceDoc: 'https://nextjs.org/docs/app/building-your-application/upgrading/version-15#cookies-and-headers',
              })
            );
          }
        }
      }

      // 5b. Synchronous params / searchParams destructuring
      if (isAppRouterFile && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        let init = node.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isIdentifier(init) && (init.text === 'params' || init.text === 'searchParams')) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'next/next15-sync-dynamic-apis',
              framework: 'next',
              category: 'architecture',
              severity: 'warning',
              snapshot,
              content,
              startOffset: node.getStart(sourceFile),
              endOffset: node.getEnd(),
              smellTitle: `Synchronous Destructuring of Next.js 15 '${init.text}'`,
              smellExplanation: `In Next.js 15, '${init.text}' is a Promise in App Router pages, layouts, and route handlers. Synchronously destructuring it before awaiting causes runtime errors.`,
              canonSummary: `Await '${init.text}' before destructuring: const { ... } = await ${init.text};`,
              canonRationale:
                'Next.js 15 makes route parameters asynchronous to align with streaming and async data boundaries.',
              canonicalCode: `export default async function Page({ params }: { params: Promise<{ id: string }> }) {\n  const { id } = await params;\n  return <div>Item {id}</div>;\n}`,
              referenceDoc: 'https://nextjs.org/docs/app/building-your-application/upgrading/version-15#params-and-searchparams',
            })
          );
        }
      }

      // 5c. Synchronous params.prop or searchParams.prop direct access
      if (isAppRouterFile && ts.isPropertyAccessExpression(node)) {
        let isDynamicProp = false;
        let paramIdent = '';

        if (ts.isIdentifier(node.expression) && (node.expression.text === 'params' || node.expression.text === 'searchParams')) {
          isDynamicProp = true;
          paramIdent = node.expression.text;
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'params' || node.expression.name.text === 'searchParams')
        ) {
          isDynamicProp = true;
          paramIdent = node.expression.name.text;
        }

        if (isDynamicProp) {
          const hasAwaited = new RegExp(`await\\s+${paramIdent}\\b`).test(content) || /await\s+props\.params\b/.test(content);
          if (!hasAwaited) {
            diagnostics.push(
              createDiagnostic({
                ruleId: 'next/next15-sync-dynamic-apis',
                framework: 'next',
                category: 'architecture',
                severity: 'warning',
                snapshot,
                content,
                startOffset: node.getStart(sourceFile),
                endOffset: node.getEnd(),
                smellTitle: `Synchronous Direct Property Access on Next.js 15 '${paramIdent}.${node.name.text}'`,
                smellExplanation: `In Next.js 15, '${paramIdent}' is a Promise in App Router pages, layouts, and route handlers. Accessing '${paramIdent}.${node.name.text}' synchronously without await causes runtime errors.`,
                canonSummary: `Await '${paramIdent}' before accessing properties: const { ${node.name.text} } = await ${paramIdent};`,
                canonRationale:
                  'Next.js 15 makes route parameters asynchronous to align with streaming and async data boundaries.',
                canonicalCode: `export default async function Page({ params }: { params: Promise<{ ${node.name.text}: string }> }) {\n  const resolved = await params;\n  return <div>Item {resolved.${node.name.text}}</div>;\n}`,
                referenceDoc: 'https://nextjs.org/docs/app/building-your-application/upgrading/version-15#params-and-searchparams',
              })
            );
          }
        }
      }
    }

    // 6. next/no-self-api-fetch-in-rsc
    if (!hasUseClientDirective && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      const firstArg = node.arguments[0];
      let urlStr: string | undefined;
      if (firstArg) {
        if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
          urlStr = firstArg.text;
        } else if (ts.isTemplateExpression(firstArg)) {
          urlStr = firstArg.head.text;
        }
      }

      if (urlStr && (urlStr.startsWith('/api/') || /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\//.test(urlStr))) {
        diagnostics.push(
          createDiagnostic({
            ruleId: 'next/no-self-api-fetch-in-rsc',
            framework: 'next',
            category: 'performance',
            severity: 'warning',
            snapshot,
            content,
            startOffset: node.getStart(sourceFile),
            endOffset: node.getEnd(),
            smellTitle: 'Self-Referential Internal API Fetch in Server Component',
            smellExplanation:
              'Calling internal /api Route Handlers via HTTP fetch inside a Server Component introduces unnecessary network loopback hops, overhead, and authentication/cookie forwarding complications.',
            canonSummary:
              'Import and call internal data access functions, database queries, or service helpers directly instead of fetching through /api.',
            canonRationale:
              'Server Components execute on the server with direct access to backend resources and databases. Bypassing HTTP fetch eliminates request latency and serialization overhead.',
            canonicalCode:
              "// Direct service call in Server Component\nimport { getProducts } from '@/lib/services/products';\n\nexport default async function ProductsPage() {\n  const products = await getProducts();\n  return <ProductList items={products} />;\n}",
            referenceDoc:
              'https://nextjs.org/docs/app/building-your-application/data-fetching/fetching-caching-and-revalidating#fetching-data-on-the-server-with-fetch',
          })
        );
      }
    }

    // 7. next/rsc-event-handler
    if (!hasUseClientDirective && ts.isJsxAttribute(node)) {
      const attrName = node.name.text;
      if (/^on[A-Z]/.test(attrName) && !attrName.startsWith('onServer')) {
        diagnostics.push(
          createDiagnostic({
            ruleId: 'next/rsc-event-handler',
            framework: 'next',
            category: 'boundary',
            severity: 'error',
            snapshot,
            content,
            startOffset: node.getStart(sourceFile),
            endOffset: node.getEnd(),
            smellTitle: 'Event Handler Bound in React Server Component',
            smellExplanation: `Event handlers like '${attrName}' cannot be passed to client elements from Server Components because functions cannot be serialized across the server/client boundary.`,
            canonSummary: `Add 'use client' directive at the top of the file or extract interactive logic to a Client Component.`,
            canonRationale:
              'Next.js App Router enforces pure static serialization for React Server Components. Interactive event listeners require client-side JavaScript execution.',
            canonicalCode: `'use client';\n\nexport default function InteractiveComponent() {\n  return <button ${attrName}={handleClick}>Click</button>;\n}`,
            referenceDoc: 'https://nextjs.org/docs/app/building-your-application/rendering/client-components',
          })
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return diagnostics;
}

