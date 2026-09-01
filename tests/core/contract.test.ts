import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractComponentContract,
  formatContractAsText,
  detectFramework,
  extractSlotsFromTemplate,
} from '../../src/engine/contract';
import { createMcpServer } from '../../src/mcp';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');
const VUE_APP_COMPONENTS = 'F:/Veritas/frontend-cadet/projects/vue-app/src/components';
const ASTRO_APP_LAYOUTS = 'F:/Veritas/frontend-cadet/projects/astro-app/src/layouts';

describe('Component Contract Extractor (Phase 2 RFC)', () => {
  it('detects component frameworks accurately by extension', () => {
    expect(detectFramework('Button.vue')).toBe('vue');
    expect(detectFramework('Component.tsx')).toBe('react');
    expect(detectFramework('Card.jsx')).toBe('react');
    expect(detectFramework('Layout.astro')).toBe('astro');
    expect(detectFramework('unknown.txt')).toBe('unknown');
  });

  it('extracts template slots using Vue compiler-dom', () => {
    const tmpl = `
      <div>
        <header><slot name="header" /></header>
        <main><slot /></main>
        <footer><slot :name="'actions'" /></footer>
      </div>
    `;
    const slots = extractSlotsFromTemplate(tmpl);
    expect(slots).toContain('header');
    expect(slots).toContain('default');
    expect(slots).toContain('actions');
  });

  it('extracts Vue component contract with props, emits, and slots (NewButton.vue)', async () => {
    const contract = await extractComponentContract(join(FIXTURES_DIR, 'NewButton.vue'));

    expect(contract.component).toBe('NewButton');
    expect(contract.framework).toBe('vue');
    expect(contract.props.length).toBe(1);
    expect(contract.props[0].name).toBe('variant');
    expect(contract.props[0].type).toBe('string');
    expect(contract.props[0].required).toBe(false);
    expect(contract.slots).toContain('default');
  });

  it('extracts Vue component contract from real enterprise project (ProductCard.vue)', async () => {
    const contract = await extractComponentContract(join(VUE_APP_COMPONENTS, 'ProductCard.vue'));

    expect(contract.component).toBe('ProductCard');
    expect(contract.framework).toBe('vue');

    // Props
    expect(contract.props.length).toBeGreaterThanOrEqual(1);
    const productProp = contract.props.find((p) => p.name === 'product');
    expect(productProp).toBeDefined();
    expect(productProp!.type).toBe('Product');
    expect(productProp!.required).toBe(true);

    // Emits
    expect(contract.emits.length).toBeGreaterThanOrEqual(1);
    const viewDetailsEmit = contract.emits.find((e) => e.name === 'view-details');
    expect(viewDetailsEmit).toBeDefined();
  });

  it('extracts React TSX component contract with props, callback emits, and children slots (CardComponent.tsx)', async () => {
    const contract = await extractComponentContract(join(FIXTURES_DIR, 'CardComponent.tsx'));

    expect(contract.component).toBe('CardComponent');
    expect(contract.framework).toBe('react');

    // Props
    expect(contract.props.some((p) => p.name === 'title' && p.required === true)).toBe(true);
    expect(contract.props.some((p) => p.name === 'description' && p.required === false)).toBe(true);
    expect(contract.props.some((p) => p.name === 'count' && p.required === false)).toBe(true);

    // Event emits (callbacks starting with 'on')
    const onActionEmit = contract.emits.find((e) => e.name === 'onAction');
    expect(onActionEmit).toBeDefined();

    // Children -> slot 'default'
    expect(contract.slots).toContain('default');
  });

  it('extracts Astro component contract with frontmatter props and template slots (Layout.astro)', async () => {
    const contract = await extractComponentContract(join(ASTRO_APP_LAYOUTS, 'Layout.astro'));

    expect(contract.component).toBe('Layout');
    expect(contract.framework).toBe('astro');

    // Frontmatter Props
    const titleProp = contract.props.find((p) => p.name === 'title');
    expect(titleProp).toBeDefined();
    expect(titleProp!.type).toBe('string');
    expect(titleProp!.required).toBe(true);

    // Slots
    expect(contract.slots).toContain('default');
  });

  it('formats contract into token-efficient, human-readable text summary', async () => {
    const contract = await extractComponentContract(join(FIXTURES_DIR, 'CardComponent.tsx'));
    const text = formatContractAsText(contract);

    expect(text).toContain('Component: CardComponent (react)');
    expect(text).toContain('Props:');
    expect(text).toContain('- title: string (required)');
    expect(text).toContain('Emits:');
    expect(text).toContain('- onAction');
    expect(text).toContain('Slots:');
    expect(text).toContain('- default');
  });

  it('invokes extract_component_contract via MCP tool handler', async () => {
    const server = createMcpServer();
    const handlers = (server as any)._requestHandlers;
    const callHandler = handlers.get('tools/call');

    const res = await callHandler({
      method: 'tools/call',
      params: {
        name: 'extract_component_contract',
        arguments: {
          path: join(FIXTURES_DIR, 'NewButton.vue'),
          output_format: 'json',
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.component).toBe('NewButton');
    expect(parsed.framework).toBe('vue');
    expect(parsed.props[0].name).toBe('variant');
  });
});
