import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractApiHandlers,
  extractRouteParams,
  formatRoutesAsText,
  scanRoutes,
} from '../../src/engine/routes';

const INERTIA_APP_DIR = join(import.meta.dir, '../mock-projects/inertia-app');

describe('File-Based Route Topology Engine (Phase 4)', () => {
  describe('extractRouteParams', () => {
    it('extracts dynamic parameters from path segments', () => {
      const params = extractRouteParams('/products/[id]/details');
      expect(params.length).toBe(1);
      expect(params[0].name).toBe('id');
      expect(params[0].type).toBe('dynamic');
    });

    it('extracts catch-all parameters from path segments', () => {
      const params = extractRouteParams('/docs/[...slug]');
      expect(params.length).toBe(1);
      expect(params[0].name).toBe('slug');
      expect(params[0].type).toBe('catch-all');
    });

    it('extracts optional catch-all parameters from path segments', () => {
      const params = extractRouteParams('/shop/[[...categories]]');
      expect(params.length).toBe(1);
      expect(params[0].name).toBe('categories');
      expect(params[0].type).toBe('optional-catch-all');
    });
  });

  describe('scanRoutes on Inertia.js (mock-projects/inertia-app)', () => {
    it('automatically detects Inertia framework and scans all page routes', async () => {
      const result = await scanRoutes({
        targetPath: INERTIA_APP_DIR,
      });

      expect(result.framework).toBe('inertia');
      expect(result.totalRoutes).toBe(3);
      expect(result.routes.some((r) => r.path === '/dashboard')).toBe(true);
      expect(result.routes.some((r) => r.path === '/auth/login')).toBe(true);
      expect(result.routes.some((r) => r.path === '/products/[id]')).toBe(true);

      const formatted = formatRoutesAsText(result);
      expect(formatted).toContain('Route Manifest (inertia)');
      expect(formatted).toContain('/dashboard [page]');
      expect(formatted).toContain('/products/[id] [page]');
    });
  });

  describe('formatRoutesAsText', () => {
    it('formats a RouteManifestResult into readable output', () => {
      const sample = {
        framework: 'next-app' as const,
        baseDirectory: 'app',
        totalRoutes: 2,
        routes: [
          {
            path: '/',
            filePath: 'app/page.tsx',
            type: 'page' as const,
            framework: 'next-app' as const,
            params: [],
            layouts: ['app/layout.tsx'],
          },
          {
            path: '/api/users',
            filePath: 'app/api/users/route.ts',
            type: 'api' as const,
            framework: 'next-app' as const,
            params: [],
            handlers: ['GET', 'POST'],
          },
        ],
      };

      const text = formatRoutesAsText(sample);
      expect(text).toContain('Route Manifest (next-app)');
      expect(text).toContain('/ [page]');
      expect(text).toContain('Layouts: app/layout.tsx');
      expect(text).toContain('/api/users [api] (handlers: GET, POST)');
    });
  });
});
