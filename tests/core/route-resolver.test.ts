import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  normalizeRoutePath,
  resolveRouteEntry,
} from '../../src/engine/routes';
import { getComponentTree, formatTreeAsText } from '../../src/engine/tree';

const INERTIA_APP_DIR = join(import.meta.dir, '../mock-projects/inertia-app');

describe('Route-to-Component Tree Resolver', () => {
  describe('normalizeRoutePath', () => {
    it('normalizes routes with or without leading/trailing slashes', () => {
      expect(normalizeRoutePath('catalog')).toBe('/catalog');
      expect(normalizeRoutePath('/catalog/')).toBe('/catalog');
      expect(normalizeRoutePath('///catalog///')).toBe('/catalog');
      expect(normalizeRoutePath('/')).toBe('/');
      expect(normalizeRoutePath('')).toBe('/');
    });
  });

  describe('resolveRouteEntry', () => {
    it('resolves exact static route to entry file and framework', async () => {
      const result = await resolveRouteEntry(INERTIA_APP_DIR, '/dashboard');
      expect(result.matched).toBe(true);
      expect(result.matchedPattern).toBe('/dashboard');
      expect(result.framework).toBe('inertia');
      expect(result.filePath).toBeDefined();
      expect(result.filePath).toContain('Dashboard.vue');
    });

    it('resolves dynamic route pattern and extracts params', async () => {
      const result = await resolveRouteEntry(INERTIA_APP_DIR, '/products/42');
      expect(result.matched).toBe(true);
      expect(result.matchedPattern).toBe('/products/[id]');
      expect(result.params?.id).toBe('42');
      expect(result.filePath).toContain('[id].vue');
    });

    it('returns matched=false and lists available routes when route is missing', async () => {
      const result = await resolveRouteEntry(INERTIA_APP_DIR, '/non-existent-route');
      expect(result.matched).toBe(false);
      expect(result.availableRoutes).toBeDefined();
      expect(result.availableRoutes?.length).toBeGreaterThan(0);
      expect(result.availableRoutes).toContain('/dashboard');
    });
  });

  describe('getComponentTree with routePath', () => {
    it('resolves downward tree directly from route_path', async () => {
      const result = await getComponentTree({
        routePath: '/dashboard',
        targetPath: INERTIA_APP_DIR,
        maxDepth: 2,
      });

      expect(result.resolvedRoute).toBeDefined();
      expect(result.resolvedRoute?.routePath).toBe('/dashboard');
      expect(result.resolvedRoute?.matchedRoute).toBe('/dashboard');
      expect(result.resolvedRoute?.framework).toBe('inertia');
      expect(result.root.component).toBe('Dashboard.vue');

      const text = formatTreeAsText(result);
      expect(text).toContain('Route: /dashboard');
      expect(text).toContain('Framework: inertia');
      expect(text).toContain('Dashboard.vue');
    });

    it('throws descriptive error if route cannot be resolved', async () => {
      expect(
        getComponentTree({
          routePath: '/unknown-route',
          targetPath: INERTIA_APP_DIR,
        })
      ).rejects.toThrow('could not be resolved');
    });
  });
});
