import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { scanDynamicImportsAndGlobals } from '../../src/engine/dynamic-imports';
import { findUnusedComponents } from '../../src/engine/audit';

describe('Sprint 2 — Dynamic Imports & Global Component Whitelist', () => {
  it('detects import.meta.glob patterns and matches files in target directory', async () => {
    const fixtureDir = join(import.meta.dir, '../fixtures');
    const fileContents = [
      {
        file: join(fixtureDir, 'app.js'),
        content: `
          import { createApp } from 'vue';
          const pages = import.meta.glob('./*.vue');
        `,
      },
    ];
    const allFiles = [
      join(fixtureDir, 'PageOne.vue'),
      join(fixtureDir, 'PageThree.vue'),
      join(fixtureDir, 'Barrel.ts'),
    ];

    const registry = await scanDynamicImportsAndGlobals(fixtureDir, fileContents, allFiles);

    expect(registry.globPatterns.length).toBeGreaterThan(0);
    expect(registry.globPatterns[0].pattern).toBe('./*.vue');
    expect(registry.globMatchedFiles.has(join(fixtureDir, 'PageOne.vue'))).toBe(true);
    expect(registry.globMatchedFiles.has(join(fixtureDir, 'PageThree.vue'))).toBe(true);
  });

  it('detects global components registered via app.component', async () => {
    const fixtureDir = join(import.meta.dir, '../fixtures');
    const fileContents = [
      {
        file: join(fixtureDir, 'main.ts'),
        content: `
          import AppButton from './NewButton.vue';
          app.component('AppButton', AppButton);
        `,
      },
    ];
    const allFiles = [join(fixtureDir, 'NewButton.vue')];

    const registry = await scanDynamicImportsAndGlobals(fixtureDir, fileContents, allFiles);

    expect(registry.globalComponents.has('appbutton')).toBe(true);
    const comp = registry.globalComponents.get('appbutton');
    expect(comp?.name).toBe('AppButton');
    expect(comp?.specifier).toBe('./NewButton.vue');
  });

  it('whitelists dynamic glob components in findUnusedComponents', async () => {
    const inertiaAppDir = join(import.meta.dir, '../mock-projects/inertia-app');

    // In inertia-app, Dashboard.vue and Profile.vue are resolved dynamically
    const result = await findUnusedComponents({
      targetPath: inertiaAppDir,
      excludePages: false, // evaluate all components including pages
    });

    // Components matched by import.meta.glob should NOT be reported as unused
    const unusedNames = result.unusedComponents.map((c) => c.name);
    expect(unusedNames).not.toContain('Dashboard');
    expect(unusedNames).not.toContain('Profile');
  });
});
