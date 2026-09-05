import { describe, expect, it } from 'bun:test';
import { formatContractAsText, formatMatchesAsText } from '../../src/engine/formatter';
import type { ComponentContract, ResolvedMatch } from '../../src/types';

describe('Formatter Engine (tests/core/formatter.test.ts)', () => {
  describe('formatMatchesAsText', () => {
    it('returns fallback message when matches array is empty', () => {
      expect(formatMatchesAsText([])).toBe('No matches found.');
    });

    it('formats single match without clientDirective cleanly', () => {
      const matches: ResolvedMatch[] = [
        {
          file: 'src/components/Button.vue',
          line: 12,
          column: 4,
          snippet: '<Button variant="primary">Submit</Button>',
        },
      ];
      const output = formatMatchesAsText(matches);
      expect(output).toBe('src/components/Button.vue:12:4 - <Button variant="primary">Submit</Button>');
    });

    it('formats matches with Astro island clientDirective', () => {
      const matches: ResolvedMatch[] = [
        {
          file: 'src/pages/index.astro',
          line: 45,
          column: 2,
          clientDirective: 'client:visible',
          snippet: '<HeroIsland client:visible />',
        },
        {
          file: 'src/pages/checkout.astro',
          line: 10,
          column: 1,
          clientDirective: 'client:load',
          snippet: '<PaymentForm client:load />',
        },
      ];
      const output = formatMatchesAsText(matches);
      expect(output).toContain('src/pages/index.astro:45:2 [client:visible] - <HeroIsland client:visible />');
      expect(output).toContain('src/pages/checkout.astro:10:1 [client:load] - <PaymentForm client:load />');
    });
  });

  describe('formatContractAsText', () => {
    it('formats a minimal contract with no props, emits, or slots', () => {
      const minimalContract: ComponentContract = {
        component: 'EmptyView',
        framework: 'vue',
        filePath: 'src/views/EmptyView.vue',
        props: [],
        emits: [],
        slots: [],
      };

      const output = formatContractAsText(minimalContract);
      expect(output).toContain('Component: EmptyView (vue)');
      expect(output).toContain('File: src/views/EmptyView.vue');
      expect(output).toContain('Props:\n  (none)');
      expect(output).toContain('Emits:\n  (none)');
      expect(output).toContain('Slots:\n  (none)');
    });

    it('formats a full-featured v0.7.0 contract with boundary and form contracts', () => {
      const fullContract: ComponentContract = {
        component: 'CadetCreate',
        framework: 'vue',
        filePath: 'resources/js/Pages/Cadets/Create.vue',
        renderBoundary: {
          boundary: 'client',
          directive: 'client:visible',
        },
        props: [
          {
            name: 'cohort',
            type: 'number',
            required: true,
            default: '2026',
          },
          {
            name: 'status',
            type: "'active' | 'graduated' | 'suspended'",
            required: false,
            isUnion: true,
            unionMembers: ["'active'", "'graduated'", "'suspended'"],
          },
        ],
        inferredProps: [
          {
            propName: 'cadetData',
            properties: [
              {
                property: 'name',
                inferredType: 'string',
                usageSnippet: 'cadetData.name',
              },
            ],
          },
        ],
        models: [
          {
            name: 'modelValue',
            type: 'string',
            required: true,
            default: "''",
          },
        ],
        variants: {
          variants: {
            variant: ['primary', 'outline'],
            size: ['sm', 'lg'],
          },
          defaultVariants: {
            variant: 'primary',
            size: 'sm',
          },
        },
        emits: [
          {
            name: 'submitted',
            payload: '{ id: number }',
          },
        ],
        slots: ['header', 'default'],
        slotDetails: [
          {
            name: 'header',
            isScoped: true,
            payload: { title: 'string', badge: 'BadgeProps' },
          },
          {
            name: 'default',
            isScoped: false,
          },
        ],
        exposed: ['resetForm', 'validate'],
        stateDependencies: {
          stores: ['useCadetStore'],
          contexts: ['CadetThemeContext'],
          composables: ['useForm'],
        },
        dataDependencies: {
          serverActions: ['storeCadetAction'],
          queryKeys: ["['cadets']"],
          endpoints: ['/api/cadets'],
          mutations: ['POST /cadets/store'],
        },
        globalSymbols: [
          {
            name: 'route',
            category: 'ziggy-route',
            hint: "Ziggy helper route('cadets.store')",
          },
        ],
        styleTokens: {
          layoutTraps: ['overflow-hidden', 'fixed'],
          zIndices: ['z-50'],
          overflow: ['overflow-hidden'],
          positioning: ['fixed'],
        },
        reactivitySmells: [
          {
            type: 'vue-props-destructure',
            severity: 'warning',
            line: 8,
            message: 'Reactive prop destructuring loses reactivity tracking in Vue 3',
            snippet: 'const { cohort } = defineProps()',
            recommendation: 'Use toRefs(props) or access via props.cohort',
          },
        ],
        boundaryContracts: [
          {
            boundaryType: 'inertia-form',
            method: 'POST',
            targetEndpoint: '/cadets/store',
            endpointSource: 'literal',
            payloadKeys: ['name', 'cohort', 'avatar'],
            loc: { line: 24, column: 5 },
          },
        ],
        formContracts: [
          {
            binding: 'cadetForm',
            isMultipart: true,
            fields: [
              { key: 'name', type: 'text', required: true },
              { key: 'avatar', type: 'file', required: true },
            ],
          },
        ],
      };

      const output = formatContractAsText(fullContract);

      // Basic info
      expect(output).toContain('Component: CadetCreate (vue)');
      expect(output).toContain("Render Boundary: client ('client:visible')");

      // Props & Inferred Props
      expect(output).toContain('- cohort: number (required, default: 2026)');
      expect(output).toContain("status: 'active' | 'graduated' | 'suspended' (optional) [options: 'active' | 'graduated' | 'suspended']");
      expect(output).toContain('• .name: string (cadetData.name)');

      // Models & Variants
      expect(output).toContain('Models (Two-Way Bindings):');
      expect(output).toContain('- v-model (string) [REQUIRED] (default: \'\')');
      expect(output).toContain('Variants:');
      expect(output).toContain('- variant: ["primary", "outline"] (default: "primary")');

      // Emits & Slots
      expect(output).toContain('- submitted (payload: { id: number })');
      expect(output).toContain('Slots:');
      expect(output).toContain('- header (scoped payload: { title: string, badge: BadgeProps })');
      expect(output).toContain('- default');

      // Exposed & Dependencies
      expect(output).toContain('Exposed:\n  - resetForm\n  - validate');
      expect(output).toContain('- Stores: useCadetStore');
      expect(output).toContain('- Context/Injected: CadetThemeContext');
      expect(output).toContain('- Composables: useForm');
      expect(output).toContain('- Server Actions: storeCadetAction');
      expect(output).toContain('- Form Mutations: POST /cadets/store');

      // Diagnostics & Boundary Contracts
      expect(output).toContain('Reactivity Smells (1 detected):');
      expect(output).toContain('Line 8: Reactive prop destructuring loses reactivity tracking in Vue 3');
      expect(output).toContain('Data Fetching & Boundary Contracts (1 detected):');
      expect(output).toContain('Line 24: [inertia-form] POST /cadets/store [payload: name, cohort, avatar]');
      expect(output).toContain('Form & Field Contracts:');
      expect(output).toContain('Form binding: "cadetForm" (multipart/form-data)');
      expect(output).toContain('• avatar (file) [REQUIRED]');
    });
  });
});
