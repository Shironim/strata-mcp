import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractApiHandlers,
  extractRouteParams,
  formatRoutesAsText,
  scanRoutes,
} from '../../src/engine/routes';

const TOKO_KM_PATH = 'F:/Veritas/toko-km';

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

  describe('scanRoutes on Inertia.js (toko-km)', () => {
    it.skipIf(!existsSync(TOKO_KM_PATH))(
      'automatically detects Inertia framework and scans all page routes',
      async () => {
        const result = await scanRoutes({
          targetPath: TOKO_KM_PATH,
        });

      expect(result.framework).toBe('inertia');
      expect(result.totalRoutes).toBeGreaterThan(10);
      expect(result.routes.some((r) => r.path === '/dashboard')).toBe(true);

      const formatted = formatRoutesAsText(result);
      expect(formatted).toContain('Route Manifest (inertia)');
      expect(formatted).toContain('/dashboard [page]');
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
