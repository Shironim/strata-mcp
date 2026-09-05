import { describe, expect, it, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  findProjectRoot,
  resolveWorkspacePath,
  resolveProjectRoot,
  setLastKnownProjectRoot,
  getLastKnownProjectRoot,
  clearLastKnownProjectRoot,
  PROJECT_ROOT_MARKERS,
} from '../../src/engine/path-resolver';

describe('Sprint 1 — Path Resolver & Project Root Auto-Discovery', () => {
  beforeEach(() => {
    clearLastKnownProjectRoot();
  });

  it('contains critical fullstack and frontend root markers including composer.json', () => {
    expect(PROJECT_ROOT_MARKERS).toContain('package.json');
    expect(PROJECT_ROOT_MARKERS).toContain('composer.json');
    expect(PROJECT_ROOT_MARKERS).toContain('.git');
    expect(PROJECT_ROOT_MARKERS).toContain('vite.config.ts');
  });

  it('detects project root walking up from a nested directory', () => {
    const nestedDir = join(import.meta.dir, '../fixtures/vue');
    const root = findProjectRoot(nestedDir);
    expect(root).not.toBeNull();
    // Should resolve to the repo root where package.json lives
    expect(root).toContain('strata-mcp');
  });

  it('stores and retrieves last known project root in session memory', () => {
    expect(getLastKnownProjectRoot()).toBeUndefined();
    setLastKnownProjectRoot('/mock/projects/frontend-app');
    expect(getLastKnownProjectRoot()).toContain('frontend-app');
  });

  it('resolves relative file path using session project root', () => {
    const mockRoot = join(import.meta.dir, '../fixtures');
    setLastKnownProjectRoot(mockRoot);

    // Relative path without target_path
    const resolved = resolveWorkspacePath('vue/OptionsApi.vue');
    expect(resolved).toContain('OptionsApi.vue');
    expect(resolved).toContain('fixtures');
  });

  it('resolves project root respecting explicit target directory', () => {
    const fixtureDir = join(import.meta.dir, '../fixtures');
    const root = resolveProjectRoot(fixtureDir);
    expect(root).toBe(fixtureDir);
    expect(getLastKnownProjectRoot()).toBe(fixtureDir);
  });
});
