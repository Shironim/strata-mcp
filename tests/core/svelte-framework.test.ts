import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSvelte } from '../../src/engine/svelte-sfc';
import { SvelteDocumentAdapter } from '../../src/adapters/svelte';
import { mapSourceFile } from '../../src/engine/source-map';
import { extractSvelteContract } from '../../src/engine/parsers/contract-svelte';
import { runCanonAudit } from '../../src/engine/canon';
import { scanRoutes } from '../../src/engine/routes';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';

describe('06 - Svelte Framework: Svelte 5 Runes, SFC Parsing, Contracts & Canonical Rules', () => {
  // =========================================================================
  // 1. SFC Parser & AST Descriptor (SV02)
  // =========================================================================
  describe('SV02: Svelte SFC Parser & Descriptor', () => {
    test('parses instance script, module script, template, and style blocks', () => {
      const code = `<script module lang="ts">
  export const moduleVersion = '1.0.0';
</script>

<script lang="ts">
  let { title }: { title: string } = $props();
</script>

<main>
  <h1>{title}</h1>
</main>

<style>
  h1 { font-size: 2rem; }
</style>`;

      const parsed = parseSvelte(code, 'Component.svelte');
      expect(parsed.module).not.toBeNull();
      expect(parsed.instance).not.toBeNull();
      expect(parsed.template).not.toBeNull();
      expect(parsed.styles).toBeDefined();
      expect(parsed.styles!.length).toBe(1);

      expect(parsed.module!.content).toContain("export const moduleVersion = '1.0.0';");
      expect(parsed.module!.lang).toBe('ts');
      expect(parsed.instance!.content).toContain("let { title }: { title: string } = $props();");
      expect(parsed.instance!.lang).toBe('ts');
      expect(parsed.template!.content).toContain('<h1>{title}</h1>');
      expect(parsed.styles![0].content).toContain('h1 { font-size: 2rem; }');

      // Byte-exact slice checks
      const instSub = code.slice(parsed.instance!.loc.start.offset, parsed.instance!.loc.end.offset);
      expect(instSub).toBe(parsed.instance!.content);
    });

    test('recovers gracefully from malformed template without crashing', () => {
      const code = `<script>
  let x = 1;
</script>
<div>Unclosed tag`;

      const parsed = parseSvelte(code, 'Malformed.svelte');
      expect(parsed.instance).not.toBeNull();
      expect(parsed.instance!.content).toContain('let x = 1;');
    });
  });

  // =========================================================================
  // 2. Svelte Document Adapter (SV02)
  // =========================================================================
  describe('SV02: SvelteDocumentAdapter Contract', () => {
    test('exposes module and instance script blocks and template block', () => {
      const code = `<script module>
  export const constant = 42;
</script>
<script>
  let count = $state(0);
</script>
<button onclick={() => count++}>{count}</button>`;

      const adapter = new SvelteDocumentAdapter('Counter.svelte', code);
      expect(adapter.type).toBe('svelte-sfc');
      expect(adapter.framework).toBe('svelte');
      expect(adapter.isJsx()).toBe(false);

      const scripts = adapter.getScriptBlocks();
      expect(scripts.length).toBe(2);
      expect(scripts[0].module).toBe(true);
      expect(scripts[0].content).toContain('export const constant = 42;');
      expect(scripts[1].content).toContain('let count = $state(0);');

      const template = adapter.getTemplateBlock();
      expect(template).not.toBeNull();
      expect(template!.content).toContain('<button');
    });
  });

  // =========================================================================
  // 3. Source Mapping & Slicing (SV03)
  // =========================================================================
  describe('SV03: Source Map & Precision Slicing', () => {
    test('maps script, snippets, elements, and styles with byte-exact SourceRef verification', async () => {
      const tempDir = await fs.mkdtemp(join(tmpdir(), 'strata-svelte-map-'));
      const filePath = join(tempDir, 'Card.svelte');

      const code = `<script lang="ts">
  let { title = 'Default' } = $props();
</script>

{#snippet header(author: string)}
  <div class="header">By {author}</div>
{/snippet}

<div class="card">
  <h2>{title}</h2>
</div>

<style>
  .card { border: 1px solid #ccc; }
</style>`;

      await fs.writeFile(filePath, code, 'utf-8');

      const result = await mapSourceFile(filePath);
      expect(result.documentType).toBe('svelte-sfc');
      expect(result.framework).toBe('svelte');

      // Check top-level blocks
      const scriptBlock = result.regions.find((r) => r.kind === 'block' && (r.name === 'script' || r.subkind === 'script'));
      expect(scriptBlock).toBeDefined();

      const templateBlock = result.regions.find((r) => r.kind === 'block' && (r.name === 'template' || r.subkind === 'template'));
      expect(templateBlock).toBeDefined();

      // Check snippet inside template
      const snippetRegion = templateBlock?.children?.find((r) => r.name?.startsWith('snippet:header'));
      expect(snippetRegion).toBeDefined();

      // Verify precision slicing with readSourceRef
      const scriptSlice = await readSourceRef(filePath, scriptBlock!.ref);
      expect(scriptSlice).toContain('let { title =');

      const snippetSlice = await readSourceRef(filePath, snippetRegion!.ref);
      expect(snippetSlice).toContain('{#snippet header');

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 4. Contract Extraction (SV04)
  // =========================================================================
  describe('SV04: Contract Extraction', () => {
    test('extracts Svelte 5 Runes props, $bindable models, and Snippet slots', async () => {
      const code = `<script lang="ts">
  interface Props {
    title: string;
    open?: boolean;
    count?: number;
    header?: Snippet<[string]>;
    children?: Snippet;
    onSave?: (id: string) => void;
  }

  let {
    title,
    open = $bindable(false),
    count = 0,
    header,
    children,
    onSave,
  }: Props = $props();

  export function focusInput() {
    // exposed method
  }
</script>

{#snippet footer()}
  <p>Card Footer</p>
{/snippet}

<div>
  <h1>{title}</h1>
  {@render header?.('Author')}
  {@render children?.()}
</div>`;

      const contract = await extractSvelteContract('Modal.svelte', code);

      expect(contract.framework).toBe('svelte');
      expect(contract.component).toBe('Modal');

      // Props verification
      const titleProp = contract.props.find((p) => p.name === 'title');
      expect(titleProp).toBeDefined();
      expect(titleProp!.type).toBe('string');
      expect(titleProp!.required).toBe(true);

      const openProp = contract.props.find((p) => p.name === 'open');
      expect(openProp).toBeDefined();
      expect(openProp!.default).toBe('false');

      const countProp = contract.props.find((p) => p.name === 'count');
      expect(countProp).toBeDefined();
      expect(countProp!.default).toBe('0');

      // Models ($bindable)
      expect(contract.models).toBeDefined();
      expect(contract.models!.some((m) => m.name === 'open')).toBe(true);

      // Emits (callback props)
      expect(contract.emits.some((e) => e.name === 'onSave')).toBe(true);

      // Slots (snippets & children)
      expect(contract.slots).toContain('default');
      expect(contract.slots).toContain('header');
      expect(contract.slots).toContain('footer');

      // Exposed methods
      expect(contract.exposed).toContain('focusInput');
    });

    test('extracts Svelte 4 legacy export let props, createEventDispatcher, and <slot>', async () => {
      const code = `<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let count = 10;

  const dispatch = createEventDispatcher<{
    change: { value: number };
    reset: void;
  }>();

  export function resetCounter() {
    count = 0;
    dispatch('reset');
  }
</script>

<div class="counter">
  <h2>{title}</h2>
  <slot name="prefix" />
  <span>{count}</span>
  <slot />
</div>`;

      const contract = await extractSvelteContract('LegacyCounter.svelte', code);

      expect(contract.props.find((p) => p.name === 'title')?.required).toBe(true);
      expect(contract.props.find((p) => p.name === 'count')?.default).toBe('10');

      expect(contract.emits.some((e) => e.name === 'change')).toBe(true);
      expect(contract.emits.some((e) => e.name === 'reset')).toBe(true);

      expect(contract.slots).toContain('default');
      expect(contract.slots).toContain('prefix');
      expect(contract.exposed).toContain('resetCounter');
    });
  });

  // =========================================================================
  // 5. Canonical Rules (SV05)
  // =========================================================================
  describe('SV05: Canonical AST Rules', () => {
    test('flags all 7 Svelte canonical anti-patterns with exact remediation', async () => {
      const code = `<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // Smell 1: svelte/prefer-runes-props
  export let count = 0;

  // Smell 2: svelte/prefer-runes-state-derived
  $: doubled = count * 2;

  // Smell 3: svelte/no-effect-for-derived-state
  let total = $state(0);
  $effect(() => {
    total = count * 10;
  });

  // Smell 4: svelte/no-non-bindable-prop-mutation
  let { fixedProp = 100 } = $props();
  function mutateProp() {
    fixedProp += 1;
  }

  // Smell 6: svelte/prefer-callback-props-over-dispatcher
  const dispatch = createEventDispatcher();
</script>

<!-- Smell 5: svelte/prefer-snippets-over-slots -->
<slot name="header" />

<!-- Smell 6 (template): on:click -->
<button on:click={() => mutateProp()}>Click</button>

<!-- Smell 7: svelte/each-missing-key -->
{#each items as item}
  <Card {item} />
{/each}`;

      const snapshot = {
        file: '/fake/project/Component.svelte',
        contentHash: 'mock-hash',
        totalLines: 35,
        totalBytes: code.length,
      };

      const diagnostics = await runCanonAudit(snapshot, code, 'svelte', { majorVersion: 5 });

      // Rule 1: svelte/prefer-runes-props
      const r1 = diagnostics.find((d) => d.ruleId === 'svelte/prefer-runes-props');
      expect(r1).toBeDefined();
      expect(r1!.canon.canonicalCode).toContain('let { count } = $props();');

      // Rule 2: svelte/prefer-runes-state-derived
      const r2 = diagnostics.find((d) => d.ruleId === 'svelte/prefer-runes-state-derived');
      expect(r2).toBeDefined();
      expect(r2!.canon.canonicalCode).toContain('let doubled = $derived(count * 2);');

      // Rule 3: svelte/no-effect-for-derived-state
      const r3 = diagnostics.find((d) => d.ruleId === 'svelte/no-effect-for-derived-state');
      expect(r3).toBeDefined();
      expect(r3!.canon.canonicalCode).toContain('let total = $derived(count * 10);');

      // Rule 4: svelte/no-non-bindable-prop-mutation
      const r4 = diagnostics.find((d) => d.ruleId === 'svelte/no-non-bindable-prop-mutation');
      expect(r4).toBeDefined();
      expect(r4!.canon.canonicalCode).toContain('$bindable()');

      // Rule 5: svelte/prefer-snippets-over-slots
      const r5 = diagnostics.find((d) => d.ruleId === 'svelte/prefer-snippets-over-slots');
      expect(r5).toBeDefined();
      expect(r5!.smell.title).toContain('<slot>');

      // Rule 6: svelte/prefer-callback-props-over-dispatcher
      const r6 = diagnostics.find((d) => d.ruleId === 'svelte/prefer-callback-props-over-dispatcher');
      expect(r6).toBeDefined();

      // Rule 7: svelte/each-missing-key
      const r7 = diagnostics.find((d) => d.ruleId === 'svelte/each-missing-key');
      expect(r7).toBeDefined();
      expect(r7!.canon.canonicalCode).toContain('{#each items as item (item.id)}');
    });
  });

  // =========================================================================
  // 6. SvelteKit Route Topology (SV06)
  // =========================================================================
  describe('SV06: SvelteKit Route Scanning', () => {
    test('discovers pages, layouts, api handlers, and route groups', async () => {
      const tempDir = await fs.mkdtemp(join(tmpdir(), 'strata-sveltekit-routes-'));
      const routesDir = join(tempDir, 'src', 'routes');
      await fs.mkdir(routesDir, { recursive: true });

      // Create root layout & page
      await fs.writeFile(join(routesDir, '+layout.svelte'), '<slot />');
      await fs.writeFile(join(routesDir, '+page.svelte'), '<h1>Home</h1>');

      // Create route group: (app)/dashboard
      const dashboardDir = join(routesDir, '(app)', 'dashboard');
      await fs.mkdir(dashboardDir, { recursive: true });
      await fs.writeFile(join(dashboardDir, '+page.svelte'), '<h1>Dashboard</h1>');

      // Create dynamic route: blog/[slug]
      const blogDir = join(routesDir, 'blog', '[slug]');
      await fs.mkdir(blogDir, { recursive: true });
      await fs.writeFile(join(blogDir, '+page.svelte'), '<h1>Post</h1>');

      // Create api endpoint: api/items/+server.ts
      const apiDir = join(routesDir, 'api', 'items');
      await fs.mkdir(apiDir, { recursive: true });
      await fs.writeFile(
        join(apiDir, '+server.ts'),
        `export async function GET() { return new Response('OK'); }
export async function POST() { return new Response('Created'); }`
      );

      // Scan routes
      const manifest = await scanRoutes({ targetPath: tempDir });
      expect(manifest.framework).toBe('sveltekit');

      // Check Home page
      const home = manifest.routes.find((r) => r.path === '/' && r.type === 'page');
      expect(home).toBeDefined();
      expect(home!.layouts).toBeDefined();
      expect(home!.layouts![0]).toContain('+layout.svelte');

      // Check Dashboard page in route group (app)
      const dash = manifest.routes.find((r) => r.path === '/dashboard');
      expect(dash).toBeDefined();
      expect(dash!.routeGroups).toContain('(app)');

      // Check dynamic slug param
      const blog = manifest.routes.find((r) => r.path === '/blog/[slug]');
      expect(blog).toBeDefined();
      expect(blog!.params).toEqual([{ name: 'slug', type: 'dynamic' }]);

      // Check API route with handlers
      const api = manifest.routes.find((r) => r.path === '/api/items');
      expect(api).toBeDefined();
      expect(api!.type).toBe('api');
      expect(api!.handlers).toContain('GET');
      expect(api!.handlers).toContain('POST');

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});

