import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSvelte } from '../../src/engine/svelte-sfc';
import { SvelteDocumentAdapter } from '../../src/adapters/svelte';
import { mapSourceFile } from '../../src/engine/source-map';
import { extractSvelteContract } from '../../src/engine/parsers/contract-svelte';
import { scanRoutes } from '../../src/engine/routes';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';
import { closeAllDatabases, getWorkspaceDatabase, syncWorkspace, queryStateImpact } from '../../src/engine/database';
import { extractComponentOutline } from '../../src/engine/outline';
import { extractComponentContextNodes } from '../../src/engine/graph/context-analyzer';
import { findUnusedComponents } from '../../src/engine/audit';

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
      expect(contract.slots).not.toContain('footer');
      expect(contract.slotDetails?.find(slot => slot.name === 'header')).toMatchObject({ isScoped: true, description: 'header snippet' });
      expect(contract.slotDetails?.find(slot => slot.name === 'default')).toMatchObject({ isScoped: false });

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

  // =========================================================================
  // 7. Svelte SQLite Graph Sync, Outline, Context, & Unused Audit (SV07)
  // =========================================================================
  describe('SV07: Svelte SQLite Graph Indexing, Context, Outline & Unused Audit', () => {
    test('indexes .svelte components, edges, state dependencies, and routes in SQLite graph.db', async () => {
      const tempDir = await fs.mkdtemp(join(tmpdir(), 'strata-svelte-db-'));
      try {
        await fs.writeFile(join(tempDir, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
        const compDir = join(tempDir, 'src', 'components');
        const routesDir = join(tempDir, 'src', 'routes');
        await fs.mkdir(compDir, { recursive: true });
        await fs.mkdir(routesDir, { recursive: true });

        const buttonPath = join(compDir, 'ActionButton.svelte');
        const unusedPath = join(compDir, 'UnusedWidget.svelte');
        const pagePath = join(routesDir, '+page.svelte');

        await fs.writeFile(
          buttonPath,
          `<script lang="ts">
  import { getContext } from 'svelte';
  let { label = 'Click' }: { label?: string } = $props();
  const theme = getContext('theme');
  export function triggerAction() { return label; }
</script>
<button>{label}</button>`
        );

        await fs.writeFile(
          unusedPath,
          `<script lang="ts">let { title = 'Unused' } = $props();</script><div>{title}</div>`
        );

        await fs.writeFile(
          pagePath,
          `<script lang="ts">
  import { setContext } from 'svelte';
  import ActionButton from '../components/ActionButton.svelte';
  import { useCartStore } from '../stores/useCartStore';
  setContext('theme', 'dark');
  const cartStore = useCartStore();
  cartStore.addItem('sku-1');
</script>
<ActionButton label="Buy" />`
        );

        const db = getWorkspaceDatabase(tempDir, { create: true });
        const stats = await syncWorkspace(tempDir);
        expect(stats.total).toBe(3);
        expect(stats.added).toBe(3);

        const files = db.query('SELECT path, framework FROM files ORDER BY path').all() as Array<{ path: string; framework: string }>;
        expect(files).toHaveLength(3);
        expect(files.every((f) => f.framework === 'svelte')).toBe(true);

        const edges = db.query('SELECT count(*) as c FROM edges WHERE is_rendered = 1').get() as { c: number };
        expect(edges.c).toBe(1);

        const stateImpact = await queryStateImpact(tempDir, 'useCartStore');
        expect(stateImpact.totalConsumers).toBe(1);
        expect(stateImpact.mutatorsCount).toBe(1);

        const outline = await extractComponentOutline(buttonPath, { path: buttonPath, workspaceRoot: tempDir });
        expect(outline.framework).toBe('svelte');
        expect(outline.functions.some((fn) => fn.name === 'triggerAction')).toBe(true);

        const pageCtx = extractComponentContextNodes(pagePath, await fs.readFile(pagePath, 'utf8'));
        const btnCtx = extractComponentContextNodes(buttonPath, await fs.readFile(buttonPath, 'utf8'));
        expect(pageCtx.providers.some((p) => p.key === 'theme')).toBe(true);
        expect(btnCtx.consumers.some((c) => c.key === 'theme')).toBe(true);

        const unusedAudit = await findUnusedComponents({ targetPath: tempDir });
        expect(unusedAudit.unusedComponents.some((u) => u.name === 'UnusedWidget')).toBe(true);
        expect(unusedAudit.unusedComponents.some((u) => u.name === 'ActionButton')).toBe(false);
      } finally {
        closeAllDatabases();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

