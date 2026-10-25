import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAstro } from '../../src/engine/astro-sfc';
import { AstroDocumentAdapter } from '../../src/adapters/astro';
import { mapSourceFile } from '../../src/engine/source-map';
import { extractAstroContract } from '../../src/engine/parsers/contract-astro';
import { runCanonAudit } from '../../src/engine/canon';
import { readSourceRef, readSourceSnapshot } from '../../src/engine/source-file';

describe('05 - Astro Framework: Islands Architecture, SFC Parsing & Canonical Rules', () => {
  // =========================================================================
  // 1. Frontmatter Tokenizer & Embedded Blocks (A01)
  // =========================================================================
  describe('A01: Frontmatter Tokenizer & Embedded Blocks', () => {
    test('handles --- inside string literals, template literals, and comments without premature split', () => {
      const code = `---
// --- comment with fence
const divider = "---";
const templateDivider = \`
---
multiline divider
\`;
const pageTitle = "Resilient Astro Page";
---
<main>
  <h1>{pageTitle}</h1>
</main>`;

      const parsed = parseAstro(code, 'Resilient.astro');
      expect(parsed.frontmatter).not.toBeNull();
      expect(parsed.template).not.toBeNull();
      expect(parsed.frontmatter!.content).toContain('const pageTitle = "Resilient Astro Page";');
      expect(parsed.frontmatter!.content).toContain('const divider = "---";');
      expect(parsed.template!.content.trim()).toBe('<main>\n  <h1>{pageTitle}</h1>\n</main>');

      // Exact substring reconstruction
      const fmSub = code.slice(parsed.frontmatter!.loc.start.offset, parsed.frontmatter!.loc.end.offset);
      expect(fmSub).toBe(parsed.frontmatter!.content);
    });

    test('extracts embedded <script> and <style> tags with exact offsets and attributes', () => {
      const code = `---
const title = "Embedded Blocks";
---
<div class="card">
  <h1>{title}</h1>
</div>

<script define:vars={{ title }} is:inline>
  console.log("Card mounted with title:", title);
</script>

<style is:global lang="scss">
  .card { color: red; }
</style>`;

      const parsed = parseAstro(code, 'Embedded.astro');
      expect(parsed.scripts).toBeDefined();
      expect(parsed.scripts!.length).toBe(1);
      expect(parsed.scripts![0].attrs?.['define:vars']).toBe('{{ title }}');
      expect(parsed.scripts![0].attrs?.['is:inline']).toBe(true);
      expect(parsed.scripts![0].content).toContain('console.log("Card mounted with title:", title);');

      expect(parsed.styles).toBeDefined();
      expect(parsed.styles!.length).toBe(1);
      expect(parsed.styles![0].scoped).toBe(false);
      expect(parsed.styles![0].lang).toBe('scss');
      expect(parsed.styles![0].content).toContain('.card { color: red; }');

      // Offset check
      const scriptSub = code.slice(parsed.scripts![0].loc.start.offset, parsed.scripts![0].loc.end.offset);
      expect(scriptSub).toBe(parsed.scripts![0].content);
    });
  });

  // =========================================================================
  // 2. Astro Document Adapter (A02)
  // =========================================================================
  describe('A02: Astro Document Adapter', () => {
    test('exposes frontmatter and embedded scripts via getScriptBlocks() and getDescriptor()', () => {
      const code = `---
const message = "Hello Adapter";
---
<p>{message}</p>
<script>
  console.log("Client script");
</script>`;

      const adapter = new AstroDocumentAdapter('Test.astro', code);
      expect(adapter.framework).toBe('astro');
      expect(adapter.type).toBe('astro');
      expect(adapter.isJsx()).toBe(false);

      const scriptBlocks = adapter.getScriptBlocks();
      expect(scriptBlocks.length).toBe(1);
      expect(scriptBlocks[0].type).toBe('frontmatter');
      expect(adapter.getDescriptor().scripts?.length).toBe(1);
    });
  });

  // =========================================================================
  // 3. Source Mapping: Islands & Slots (A03)
  // =========================================================================
  describe('A03: Source Mapping (Islands & Slots)', () => {
    test('maps islands, slots, embedded scripts, and styles as structured regions', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-map-'));
      const filePath = join(testDir, 'Catalog.astro');
      const code = `---
import VueCounter from './VueCounter.vue';
import ReactButton from './ReactButton.tsx';
---
<div class="container">
  <slot name="header" />
  <VueCounter client:visible initialCount={5} />
  <ReactButton client:load label="Submit" />
  <slot />
</div>

<script is:inline>
  console.log("Inline telemetry");
</script>

<style>
  .container { padding: 16px; }
</style>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const result = await mapSourceFile(filePath);

        expect(result.framework).toBe('astro');
        expect(result.documentType).toBe('astro');
        expect(result.status).toBe('complete');

        // Check top-level regions: frontmatter, template, script, style
        const kinds = result.regions.map(r => r.kind);
        expect(kinds).toContain('frontmatter');
        expect(kinds).toContain('template');
        expect(kinds).toContain('script');
        expect(kinds).toContain('style');

        // Check template children: islands and slots
        const tmplRegion = result.regions.find(r => r.kind === 'template');
        expect(tmplRegion).toBeDefined();
        expect(tmplRegion?.children).toBeDefined();

        const islandChildren = tmplRegion!.children!.filter(c => c.kind === 'island');
        expect(islandChildren.length).toBe(2);

        const vueIsland = islandChildren.find(c => c.name === 'VueCounter');
        expect(vueIsland).toBeDefined();
        expect(vueIsland?.attributes?.directive).toBe('client:visible');

        const reactIsland = islandChildren.find(c => c.name === 'ReactButton');
        expect(reactIsland).toBeDefined();
        expect(reactIsland?.attributes?.directive).toBe('client:load');

        const slotChildren = tmplRegion!.children!.filter(c => c.kind === 'slot');
        expect(slotChildren.length).toBe(2);
        expect(slotChildren.map(s => s.name)).toContain('header');
        expect(slotChildren.map(s => s.name)).toContain('default');

        // Verify SourceRef slice accuracy
        const vueIslandSnippet = await readSourceRef(filePath, vueIsland!.ref);
        expect(vueIslandSnippet).toBe('<VueCounter client:visible initialCount={5} />');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 4. Contract Extraction & Astro.props Destructuring (A04)
  // =========================================================================
  describe('A04: Contract Extraction (Props & Islands)', () => {
    test('extracts props from interface and attaches default values from Astro.props destructuring', async () => {
      const code = `---
interface Props {
  title: string;
  count?: number;
  isActive?: boolean;
}

const {
  title = "Default Title",
  count = 42,
  isActive = true,
} = Astro.props;
---
<div>
  <h1>{title}</h1>
  <span>{count}</span>
</div>`;

      const contract = await extractAstroContract('TestComponent.astro', code);
      expect(contract.component).toBe('TestComponent');
      expect(contract.framework).toBe('astro');
      expect(contract.props.length).toBe(3);

      const titleProp = contract.props.find(p => p.name === 'title');
      expect(titleProp).toBeDefined();
      expect(titleProp?.default).toBe('"Default Title"');
      expect(titleProp?.required).toBe(false);

      const countProp = contract.props.find(p => p.name === 'count');
      expect(countProp).toBeDefined();
      expect(countProp?.default).toBe('42');
    });

    test('infers props from Astro.props destructuring even when interface Props is omitted', async () => {
      const code = `---
const { headline = 'Welcome', itemsCount = 10 } = Astro.props;
---
<h2>{headline} ({itemsCount})</h2>`;

      const contract = await extractAstroContract('InferredProps.astro', code);
      expect(contract.props.length).toBe(2);

      const headlineProp = contract.props.find(p => p.name === 'headline');
      expect(headlineProp?.type).toBe('string');
      expect(headlineProp?.default).toBe("'Welcome'");

      const itemsCountProp = contract.props.find(p => p.name === 'itemsCount');
      expect(itemsCountProp?.type).toBe('number');
      expect(itemsCountProp?.default).toBe('10');
    });

    test('extracts islands contract with directive details and passed props', async () => {
      const code = `---
import Modal from './Modal.vue';
---
<div>
  <Modal client:only="vue" isOpen={false} title="Confirmation" />
</div>`;

      const contract = await extractAstroContract('IslandPage.astro', code);
      expect(contract.islands).toBeDefined();
      expect(contract.islands!.length).toBe(1);

      const island = contract.islands![0];
      expect(island.component).toBe('Modal');
      expect(island.directive).toBe('client:only');
      expect(island.directiveValue).toBe('vue');
      expect(island.props?.isOpen).toBe('{false}');
      expect(island.props?.title).toBe('Confirmation');
    });
  });

  // =========================================================================
  // 5. AST Canonical Pattern Rules (A05)
  // =========================================================================
  describe('A05: AST Canonical Pattern Rules', () => {
    test('astro/interactive-component-missing-client-directive: detects unhydrated framework component with event listeners', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'DeadIsland.astro');
      const code = `---
import InteractiveModal from './InteractiveModal.vue';
---
<div>
  <InteractiveModal isOpen={true} onClose={() => {}} />
</div>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d = diags.find(x => x.ruleId === 'astro/interactive-component-missing-client-directive');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('warning');
        expect(d?.category).toBe('boundary');
        expect(d?.smell.title).toContain('<InteractiveModal> Missing Hydration Directive');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('astro/over-hydration-client-load: detects client:load inside footer', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'FooterLoad.astro');
      const code = `---
import NewsletterForm from './NewsletterForm.vue';
---
<div>
  <h1>Page Content</h1>
  <footer>
    <NewsletterForm client:load />
  </footer>
</div>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d = diags.find(x => x.ruleId === 'astro/over-hydration-client-load');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('warning');
        expect(d?.category).toBe('performance');
        expect(d?.smell.title).toContain('Heavy \'client:load\' Island <NewsletterForm> Rendered in Footer');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('astro/client-only-missing-framework-hint: detects client:only without framework identifier', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'MissingFramework.astro');
      const code = `---
import HeavyMap from './HeavyMap.tsx';
---
<div>
  <HeavyMap client:only />
</div>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d = diags.find(x => x.ruleId === 'astro/client-only-missing-framework-hint');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.smell.title).toContain('Missing Framework Hint for \'client:only\'');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('astro/no-browser-globals-in-frontmatter: detects window/document/localStorage in frontmatter', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'ServerCrash.astro');
      const code = `---
const token = localStorage.getItem('auth_token');
const width = window.innerWidth;
---
<div>{token} ({width})</div>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d1 = diags.find(x => x.ruleId === 'astro/no-browser-globals-in-frontmatter' && x.smell.title.includes('localStorage'));
        const d2 = diags.find(x => x.ruleId === 'astro/no-browser-globals-in-frontmatter' && x.smell.title.includes('window'));
        expect(d1).toBeDefined();
        expect(d2).toBeDefined();
        expect(d1?.severity).toBe('error');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('astro/no-function-props-to-island: detects non-serializable function props passed to island', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'FunctionProp.astro');
      const code = `---
import DataTable from './DataTable.tsx';
const formatRow = (row: any) => row.id;
---
<div>
  <DataTable client:load formatRow={formatRow} />
</div>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d = diags.find(x => x.ruleId === 'astro/no-function-props-to-island');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.category).toBe('architecture');
        expect(d?.smell.title).toContain('Non-Serializable Function Prop');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    test('astro/define-vars-forces-inline-script: detects ES module import inside define:vars script tag', async () => {
      const testDir = await fs.mkdtemp(join(tmpdir(), 'strata-astro-canon-'));
      const filePath = join(testDir, 'InlineImport.astro');
      const code = `---
const apiKey = "xyz123";
---
<div>
  <h1>Protected Page</h1>
</div>

<script define:vars={{ apiKey }}>
  import { setupTelemetry } from './telemetry';
  setupTelemetry(apiKey);
</script>`;

      try {
        await fs.writeFile(filePath, code, 'utf8');
        const { snapshot, content } = await readSourceSnapshot(filePath);
        const diags = await runCanonAudit(snapshot, content, 'astro');

        const d = diags.find(x => x.ruleId === 'astro/define-vars-forces-inline-script');
        expect(d).toBeDefined();
        expect(d?.severity).toBe('error');
        expect(d?.category).toBe('architecture');
        expect(d?.smell.title).toContain('ES Module Import Inside \'<script define:vars>\' Tag');
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });
});
