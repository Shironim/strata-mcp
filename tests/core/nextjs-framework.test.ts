import { afterAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  scanRoutes,
  extractNextSegmentConfig,
} from '../../src/engine/routes';
import { getComponentTree } from '../../src/engine/tree';
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
      writeFileSync(join(testDir, 'package.json'), '{"dependencies":{"next":"15.0.0"}}');

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
      expect(contract.framework).toBe('next');
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
      writeFileSync(join(testDir, 'package.json'), '{"dependencies":{"next":"15.0.0"}}');

      const compFile = join(compDir, 'Button.tsx');
      const content = `'use client';\nexport default function Button() { return <button>Click</button>; }`;
      writeFileSync(compFile, content);

      const contract = await extractComponentContract(compFile);
      expect(contract.framework).toBe('next');
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
