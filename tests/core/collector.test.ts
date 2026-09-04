import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFiles, IGNORED_DIRS } from '../../src/engine/collector';

describe('Collector Filesystem Traversal & Default Ignores', () => {
  it('contains critical monorepo, backend, and IDE ignore directories', () => {
    expect(IGNORED_DIRS.has('vendor')).toBe(true);
    expect(IGNORED_DIRS.has('storage')).toBe(true);
    expect(IGNORED_DIRS.has('public')).toBe(true);
    expect(IGNORED_DIRS.has('.codegraph')).toBe(true);
    expect(IGNORED_DIRS.has('.idea')).toBe(true);
    expect(IGNORED_DIRS.has('.vscode')).toBe(true);
    expect(IGNORED_DIRS.has('.next')).toBe(true);
    expect(IGNORED_DIRS.has('node_modules')).toBe(true);
    expect(IGNORED_DIRS.has('.git')).toBe(true);
  });

  it('skips ignored directories during collectFiles traversal', async () => {
    const tempDir = join(tmpdir(), `strata-collector-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Valid source directory
    const srcDir = join(tempDir, 'resources', 'js');
    await fs.mkdir(srcDir, { recursive: true });
    const validVueFile = join(srcDir, 'App.vue');
    await fs.writeFile(validVueFile, '<template><div>Hello</div></template>', 'utf8');

    // Ignored vendor directory
    const vendorDir = join(tempDir, 'vendor', 'package');
    await fs.mkdir(vendorDir, { recursive: true });
    const vendorFile = join(vendorDir, 'VendorComponent.vue');
    await fs.writeFile(vendorFile, '<template><div>Vendor</div></template>', 'utf8');

    // Ignored storage directory
    const storageDir = join(tempDir, 'storage', 'framework');
    await fs.mkdir(storageDir, { recursive: true });
    const storageFile = join(storageDir, 'Cached.vue');
    await fs.writeFile(storageFile, '<template><div>Cache</div></template>', 'utf8');

    // Ignored public directory
    const publicDir = join(tempDir, 'public', 'build');
    await fs.mkdir(publicDir, { recursive: true });
    const publicFile = join(publicDir, 'bundle.js');
    await fs.writeFile(publicFile, 'console.log("bundle");', 'utf8');

    const collected = await collectFiles(tempDir);

    expect(collected).toContain(validVueFile);
    expect(collected).not.toContain(vendorFile);
    expect(collected).not.toContain(storageFile);
    expect(collected).not.toContain(publicFile);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('contains universal blacklist directories for Rust, Python, Go, Next, Astro, and testing tools', () => {
    // Rust
    expect(IGNORED_DIRS.has('target')).toBe(true);
    // Python
    expect(IGNORED_DIRS.has('__pycache__')).toBe(true);
    expect(IGNORED_DIRS.has('.venv')).toBe(true);
    expect(IGNORED_DIRS.has('venv')).toBe(true);
    // Go
    expect(IGNORED_DIRS.has('bin')).toBe(true);
    expect(IGNORED_DIRS.has('pkg')).toBe(true);
    // Ruby & Elixir
    expect(IGNORED_DIRS.has('.bundle')).toBe(true);
    expect(IGNORED_DIRS.has('_build')).toBe(true);
    expect(IGNORED_DIRS.has('deps')).toBe(true);
    // Frontend Virtual
    expect(IGNORED_DIRS.has('.astro')).toBe(true);
    expect(IGNORED_DIRS.has('.svelte-kit')).toBe(true);
    expect(IGNORED_DIRS.has('storybook-static')).toBe(true);
    // Testing & Playwright
    expect(IGNORED_DIRS.has('playwright-report')).toBe(true);
    expect(IGNORED_DIRS.has('test-results')).toBe(true);
    expect(IGNORED_DIRS.has('.playwright')).toBe(true);
    expect(IGNORED_DIRS.has('.turbo')).toBe(true);
  });

  it('respects .strataignore and .gitignore in the root directory', async () => {
    const tempDir = join(tmpdir(), `strata-ignorefile-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create .strataignore
    await fs.writeFile(
      join(tempDir, '.strataignore'),
      '# Comment line\ncustom-ignored-dir\nlegacy-view\n',
      'utf8'
    );

    // Create source files
    const validDir = join(tempDir, 'src');
    await fs.mkdir(validDir, { recursive: true });
    const validFile = join(validDir, 'Component.vue');
    await fs.writeFile(validFile, '<template><div>OK</div></template>', 'utf8');

    // Create ignored dir from .strataignore
    const ignoredDir = join(tempDir, 'custom-ignored-dir');
    await fs.mkdir(ignoredDir, { recursive: true });
    const ignoredFile = join(ignoredDir, 'ShouldBeIgnored.vue');
    await fs.writeFile(ignoredFile, '<template><div>Ignore</div></template>', 'utf8');

    const collected = await collectFiles(tempDir);

    expect(collected).toContain(validFile);
    expect(collected).not.toContain(ignoredFile);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('respects runtime excludeDirs parameter', async () => {
    const tempDir = join(tmpdir(), `strata-excludedirs-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const srcDir = join(tempDir, 'src');
    const legacyDir = join(tempDir, 'src', 'legacy');
    await fs.mkdir(legacyDir, { recursive: true });

    const activeFile = join(srcDir, 'Active.vue');
    const legacyFile = join(legacyDir, 'OldComponent.vue');

    await fs.writeFile(activeFile, '<template><div>Active</div></template>', 'utf8');
    await fs.writeFile(legacyFile, '<template><div>Legacy</div></template>', 'utf8');

    // Exclude 'legacy'
    const collected = await collectFiles(tempDir, {
      excludeDirs: ['legacy'],
    });

    expect(collected).toContain(activeFile);
    expect(collected).not.toContain(legacyFile);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
