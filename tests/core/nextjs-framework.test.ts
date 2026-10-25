import { afterAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  scanRoutes,
  extractNextSegmentConfig,
} from '../../src/engine/routes';
import { runCanonAudit } from '../../src/engine/canon';
import { getComponentTree } from '../../src/engine/graph/downward-traversal';
import { extractComponentContract } from '../../src/engine/contract';
import type { SourceSnapshot } from '../../src/types';

function createMockSnapshot(file: string, content: string): SourceSnapshot {
  return {
    file,
    sha256: 'mock-sha256-' + Date.now(),
    byteLength: Buffer.byteLength(content),
    lineCount: content.split('\n').length,
    mtimeMs: Date.now(),
  };
}

describe('Next.js Framework Support (Milestone 4)', () => {
  const baseTestDir = join(tmpdir(), `strata-next-test-${Date.now()}`);

  // NX01: Route Scanner
  describe('NX01: App Router Route Scanner & Conventions', () => {
    it('maps app/(dashboard)/settings/@modal/page.tsx to /settings with routeGroups and parallelSlot', async () => {
      const testDir = join(baseTestDir, 'nx01-routes');
      const pageDir = join(testDir, 'app', '(dashboard)', 'settings', '@modal');
      mkdirSync(pageDir, { recursive: true });

      writeFileSync(
        join(pageDir, 'page.tsx'),
        `export default function SettingsModal() { return <div>Modal</div>; }`
      );

      const result = await scanRoutes({ targetPath: testDir });
      expect(result.framework).toBe('next-app');
      expect(result.totalRoutes).toBeGreaterThanOrEqual(1);

      const targetRoute = result.routes.find((r) => r.path === '/settings');
      expect(targetRoute).toBeDefined();
      expect(targetRoute!.type).toBe('page');
      expect(targetRoute!.routeGroups).toEqual(['(dashboard)']);
      expect(targetRoute!.parallelSlot).toBe('@modal');
    });

    it('identifies App Router special conventions: loading, error, not-found, template, default, and route handlers', async () => {
      const testDir = join(baseTestDir, 'nx01-conventions');
      const appDir = join(testDir, 'app', 'dashboard');
      const apiDir = join(testDir, 'app', 'api', 'metrics');
      mkdirSync(appDir, { recursive: true });
      mkdirSync(apiDir, { recursive: true });

      writeFileSync(join(appDir, 'page.tsx'), 'export default function Page() { return <div>Dashboard</div>; }');
      writeFileSync(join(appDir, 'loading.tsx'), 'export default function Loading() { return <div>Loading...</div>; }');
      writeFileSync(join(appDir, 'error.tsx'), "'use client'; export default function Error() { return <div>Error</div>; }");
      writeFileSync(join(appDir, 'not-found.tsx'), 'export default function NotFound() { return <div>404</div>; }');
      writeFileSync(join(appDir, 'template.tsx'), 'export default function Template({ children }) { return <div>{children}</div>; }');
      writeFileSync(join(appDir, 'default.tsx'), 'export default function Default() { return <div>Default slot</div>; }');
      writeFileSync(join(apiDir, 'route.ts'), 'export async function GET() { return Response.json({ ok: true }); }');

      const result = await scanRoutes({ targetPath: testDir });
      expect(result.framework).toBe('next-app');

      const types = result.routes.map((r) => r.type);
      expect(types).toContain('page');
      expect(types).toContain('loading');
      expect(types).toContain('error');
      expect(types).toContain('not-found');
      expect(types).toContain('template');
      expect(types).toContain('default');
      expect(types).toContain('api');

      const apiRoute = result.routes.find((r) => r.path === '/api/metrics');
      expect(apiRoute).toBeDefined();
      expect(apiRoute!.handlers).toContain('GET');
    });

    it('extracts route segment config: dynamic, revalidate, runtime, preferredRegion, and generateMetadata', async () => {
      const content = `
        export const dynamic = 'force-dynamic';
        export const revalidate = 60;
        export const runtime = 'edge';
        export const preferredRegion = ['iad1', 'sfo1'];
        export const dynamicParams = true;
        export const maxDuration = 30;

        export async function generateMetadata() {
          return { title: 'Dynamic Page' };
        }

        export async function generateStaticParams() {
          return [{ id: '1' }];
        }

        export default function Page() { return <div>Page</div>; }
      `;

      const config = extractNextSegmentConfig(content);
      expect(config).toBeDefined();
      expect(config!.dynamic).toBe('force-dynamic');
      expect(config!.revalidate).toBe(60);
      expect(config!.runtime).toBe('edge');
      expect(config!.preferredRegion).toEqual(['iad1', 'sfo1']);
      expect(config!.dynamicParams).toBe(true);
      expect(config!.maxDuration).toBe(30);
      expect(config!.hasGenerateMetadata).toBe(true);
      expect(config!.hasGenerateStaticParams).toBe(true);
    });
  });

  // NX02 & NX03: Next.js Canonical Pattern Rules
  describe('NX03: Next.js Canon AST Rules', () => {
    describe('next/no-use-client-at-page-root', () => {
      it('flags "use client" on app/**/page.tsx root', async () => {
        const file = '/app/users/page.tsx';
        const content = `'use client';\n\nexport default function UsersPage() { return <div>Users</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-use-client-at-page-root');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('warning');
        expect(match!.category).toBe('architecture');
      });

      it('does NOT flag "use client" on non-root leaf components (negative test)', async () => {
        const file = '/src/components/UserTable.tsx';
        const content = `'use client';\n\nexport default function UserTable() { return <table></table>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-use-client-at-page-root');
        expect(match).toBeUndefined();
      });
    });

    describe('next/error-boundary-must-be-client', () => {
      it('flags app/dashboard/error.tsx when missing "use client"', async () => {
        const file = '/app/dashboard/error.tsx';
        const content = `export default function ErrorBoundary({ error, reset }: any) { return <button onClick={reset}>Retry</button>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/error-boundary-must-be-client');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('error');
        expect(match!.category).toBe('boundary');
      });

      it('does NOT flag error.tsx when "use client" is present (negative test)', async () => {
        const file = '/app/dashboard/error.tsx';
        const content = `'use client';\n\nexport default function ErrorBoundary({ error, reset }: any) { return <button onClick={reset}>Retry</button>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/error-boundary-must-be-client');
        expect(match).toBeUndefined();
      });
    });

    describe('next/no-async-client-component', () => {
      it('flags async function client component in "use client" file', async () => {
        const file = '/app/components/Profile.tsx';
        const content = `'use client';\n\nexport default async function Profile() { return <div>Async Client</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-async-client-component');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('error');
      });

      it('does NOT flag async Server Component without "use client" (negative test)', async () => {
        const file = '/app/profile/page.tsx';
        const content = `export default async function ProfilePage() { return <div>Server Component</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-async-client-component');
        expect(match).toBeUndefined();
      });

      it('does NOT flag inline Server Action with "use server" inside client file (negative test)', async () => {
        const file = '/app/components/Form.tsx';
        const content = `
          'use client';
          export default function Form() {
            async function onSubmit() {
              'use server';
              // server mutation
            }
            return <form action={onSubmit}><button>Send</button></form>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-async-client-component');
        expect(match).toBeUndefined();
      });
    });

    describe('next/server-secret-in-client', () => {
      it('flags server modules (fs, pg, prisma) imported into "use client"', async () => {
        const file = '/app/components/SecretClient.tsx';
        const content = `'use client';\nimport fs from 'node:fs';\nexport default function Comp() { return <div>Test</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/server-secret-in-client');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('error');
        expect(match!.category).toBe('security');
      });

      it('flags non-NEXT_PUBLIC_ environment variables accessed in "use client"', async () => {
        const file = '/app/components/SecretClient.tsx';
        const content = `'use client';\nexport default function Comp() { const dbUrl = process.env.DATABASE_URL; return <div>{dbUrl}</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/server-secret-in-client');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('error');
      });

      it('does NOT flag NEXT_PUBLIC_ or NODE_ENV variables in "use client" (negative test)', async () => {
        const file = '/app/components/PublicClient.tsx';
        const content = `'use client';\nexport default function Comp() { const api = process.env.NEXT_PUBLIC_API_URL; const env = process.env.NODE_ENV; return <div>{api} - {env}</div>; }`;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/server-secret-in-client');
        expect(match).toBeUndefined();
      });
    });

    describe('next/next15-sync-dynamic-apis', () => {
      it('flags synchronous cookies() call without await on Next.js 15', async () => {
        const file = '/app/dashboard/page.tsx';
        const content = `
          import { cookies } from 'next/headers';
          export default function Page() {
            const cookieStore = cookies();
            const token = cookieStore.get('token');
            return <div>Token</div>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next', { majorVersion: 15 });
        const match = diags.find((d) => d.ruleId === 'next/next15-sync-dynamic-apis');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('warning');
      });

      it('flags synchronous params destructuring in App Router page on Next.js 15', async () => {
        const file = '/app/blog/[slug]/page.tsx';
        const content = `
          export default function Page({ params }: { params: any }) {
            const { slug } = params;
            return <h1>{slug}</h1>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next', { majorVersion: 15 });
        const match = diags.find((d) => d.ruleId === 'next/next15-sync-dynamic-apis');
        expect(match).toBeDefined();
      });

      it('flags direct params.slug property access in App Router on Next.js 15', async () => {
        const file = '/app/blog/[slug]/page.tsx';
        const content = `
          export default function Page(props: { params: { slug: string } }) {
            return <h1>{props.params.slug}</h1>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next', { majorVersion: 15 });
        const match = diags.find((d) => d.ruleId === 'next/next15-sync-dynamic-apis');
        expect(match).toBeDefined();
      });

      it('does NOT flag awaited cookies() and awaited params on Next.js 15 (negative test)', async () => {
        const file = '/app/blog/[slug]/page.tsx';
        const content = `
          import { cookies } from 'next/headers';
          export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
            const { slug } = await params;
            const cookieStore = await cookies();
            const token = cookieStore.get('token');
            return <h1>{slug}</h1>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next', { majorVersion: 15 });
        const match = diags.find((d) => d.ruleId === 'next/next15-sync-dynamic-apis');
        expect(match).toBeUndefined();
      });
    });

    describe('next/no-self-api-fetch-in-rsc', () => {
      it('flags internal /api fetch in Server Component', async () => {
        const file = '/app/products/page.tsx';
        const content = `
          export default async function ProductsPage() {
            const res = await fetch('http://localhost:3000/api/products');
            const data = await res.json();
            return <div>{data.length}</div>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-self-api-fetch-in-rsc');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('warning');
        expect(match!.category).toBe('performance');
      });

      it('does NOT flag external fetch in Server Component (negative test)', async () => {
        const file = '/app/products/page.tsx';
        const content = `
          export default async function ProductsPage() {
            const res = await fetch('https://api.stripe.com/v1/charges');
            return <div>Stripe</div>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/no-self-api-fetch-in-rsc');
        expect(match).toBeUndefined();
      });
    });

    describe('next/rsc-event-handler', () => {
      it('flags DOM onClick event handler in Server Component without "use client"', async () => {
        const file = '/app/components/ServerButton.tsx';
        const content = `
          export default function ServerButton() {
            return <button onClick={() => alert('hi')}>Click</button>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/rsc-event-handler');
        expect(match).toBeDefined();
        expect(match!.severity).toBe('error');
      });

      it('does NOT flag onClick in Client Component with "use client" (negative test)', async () => {
        const file = '/app/components/ClientButton.tsx';
        const content = `
          'use client';
          export default function ClientButton() {
            return <button onClick={() => alert('hi')}>Click</button>;
          }
        `;
        const snapshot = createMockSnapshot(file, content);

        const diags = await runCanonAudit(snapshot, content, 'next');
        const match = diags.find((d) => d.ruleId === 'next/rsc-event-handler');
        expect(match).toBeUndefined();
      });
    });
  });

  // NX04: Transitive Client Boundary
  describe('NX04: Transitive Client Boundary in Component Tree', () => {
    it('marks imported child without "use client" as client-hydrated (inherited from parent)', async () => {
      const testDir = join(baseTestDir, 'nx04-tree');
      const appDir = join(testDir, 'app', 'dashboard');
      const compDir = join(testDir, 'components');
      mkdirSync(appDir, { recursive: true });
      mkdirSync(compDir, { recursive: true });

      const pageFile = join(appDir, 'page.tsx');
      const cardFile = join(compDir, 'MetricsCard.tsx');

      // Parent client component
      writeFileSync(
        pageFile,
        `'use client';\nimport { MetricsCard } from '../../components/MetricsCard';\nexport default function Dashboard() { return <MetricsCard title="Revenue" />; }`
      );

      // Child component WITHOUT 'use client'
      writeFileSync(
        cardFile,
        `export function MetricsCard({ title }: { title: string }) { return <div className="card">{title}</div>; }`
      );

      const tree = await getComponentTree({
        entryPath: pageFile,
        maxDepth: 3,
      });

      expect(tree.root.children.length).toBe(1);
      const childNode = tree.root.children[0];
      expect(childNode.component).toBe('MetricsCard.tsx');
      expect(childNode.transitiveBoundary).toBe('client-hydrated (inherited from parent)');
    });

    it('does NOT mark child as transitive client when imported by Server Component (negative test)', async () => {
      const testDir = join(baseTestDir, 'nx04-server-tree');
      const appDir = join(testDir, 'app', 'dashboard');
      const compDir = join(testDir, 'components');
      mkdirSync(appDir, { recursive: true });
      mkdirSync(compDir, { recursive: true });

      const pageFile = join(appDir, 'page.tsx');
      const cardFile = join(compDir, 'ServerCard.tsx');

      // Parent is Server Component (no 'use client')
      writeFileSync(
        pageFile,
        `import { ServerCard } from '../../components/ServerCard';\nexport default function Dashboard() { return <ServerCard title="Stats" />; }`
      );

      // Child component
      writeFileSync(
        cardFile,
        `export function ServerCard({ title }: { title: string }) { return <div>{title}</div>; }`
      );

      const tree = await getComponentTree({
        entryPath: pageFile,
        maxDepth: 3,
      });

      expect(tree.root.children.length).toBe(1);
      const childNode = tree.root.children[0];
      expect(childNode.transitiveBoundary).toBeUndefined();
    });
  });

  // NX02: Contract & Evidence Integration
  describe('NX02: Contract Extraction & Evidence Boundaries', () => {
    it('extractComponentContract resolves renderBoundary evidence and segment config', async () => {
      const testDir = join(baseTestDir, 'nx02-contract');
      const appDir = join(testDir, 'app', 'settings');
      mkdirSync(appDir, { recursive: true });

      const pageFile = join(appDir, 'page.tsx');
      const content = `
        export const dynamic = 'force-dynamic';
        export const revalidate = 0;
        export default function SettingsPage() {
          return <div>Settings</div>;
        }
      `;
      writeFileSync(pageFile, content);

      const contract = await extractComponentContract(pageFile);
      expect(contract.renderBoundary).toBeDefined();
      expect(contract.renderBoundary!.boundary).toBe('server-component');
      expect(contract.renderBoundary!.isClientHydrated).toBe(false);
      expect(contract.renderBoundary!.evidence).toBeDefined();
      expect(contract.renderBoundary!.evidence!.method).toBe('app-router-convention');

      expect(contract.nextSegmentConfig).toBeDefined();
      expect(contract.nextSegmentConfig!.dynamic).toBe('force-dynamic');
      expect(contract.nextSegmentConfig!.revalidate).toBe(0);
    });

    it('extractComponentContract marks client component with directive evidence', async () => {
      const testDir = join(baseTestDir, 'nx02-client-contract');
      const compDir = join(testDir, 'components');
      mkdirSync(compDir, { recursive: true });

      const compFile = join(compDir, 'Button.tsx');
      const content = `'use client';\nexport default function Button() { return <button>Click</button>; }`;
      writeFileSync(compFile, content);

      const contract = await extractComponentContract(compFile);
      expect(contract.renderBoundary).toBeDefined();
      expect(contract.renderBoundary!.boundary).toBe('client-component');
      expect(contract.renderBoundary!.isClientHydrated).toBe(true);
      expect(contract.renderBoundary!.evidence?.method).toBe('directive-node');
    });
  });

  // Clean up
  afterAll(() => {
    try {
      rmSync(baseTestDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
