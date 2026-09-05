import { describe, expect, it } from 'bun:test';
import { extractBoundaryContracts, extractFormContracts } from '../../src/engine/contract';
import { extractComponentContextNodes } from '../../src/engine/tree';
import { auditBundleHealth } from '../../src/engine/bundle-audit';
import type { ContextDependencyNode, ContextDependencyRelation } from '../../src/types';

describe('Strata MCP — The Frontend Contract Master (4 Pillars)', () => {
  describe('Pillar 1: Universal Data Fetching & Boundary Contract', () => {
    it('extracts Inertia.js useForm and form.post boundary with payload keys', () => {
      const code = `
        <script setup>
        import { useForm } from '@inertiajs/vue3';

        const form = useForm({
          name: '',
          email: '',
          cadet_rank: 'Junior',
          cohort_year: 2026,
        });

        function submit() {
          form.post('/cadets/store');
        }
        </script>
      `;

      const boundaries = extractBoundaryContracts(code, 'vue');
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].boundaryType).toBe('inertia-form');
      expect(boundaries[0].method).toBe('POST');
      expect(boundaries[0].targetEndpoint).toBe('/cadets/store');
      expect(boundaries[0].endpointSource).toBe('literal');
      expect(boundaries[0].payloadKeys).toEqual(['name', 'email', 'cadet_rank', 'cohort_year']);
    });

    it('extracts Inertia Ziggy route helper in form submission', () => {
      const code = `
        const form = useForm({ title: '', content: '' });
        const save = () => form.post(route('posts.store'));
      `;

      const boundaries = extractBoundaryContracts(code, 'vue');
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].boundaryType).toBe('inertia-form');
      expect(boundaries[0].targetEndpoint).toBe("route('posts.store')");
      expect(boundaries[0].endpointSource).toBe('ziggy-route');
      expect(boundaries[0].payloadKeys).toEqual(['title', 'content']);
    });

    it('extracts Nuxt useFetch and $fetch with method and body keys', () => {
      const code = `
        const { data } = await useFetch('/api/cadets', {
          method: 'POST',
          body: {
            fullName: 'Dimas',
            role: 'Officer',
          }
        });
      `;

      const boundaries = extractBoundaryContracts(code, 'vue');
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].boundaryType).toBe('nuxt-fetch');
      expect(boundaries[0].method).toBe('POST');
      expect(boundaries[0].targetEndpoint).toBe('/api/cadets');
      expect(boundaries[0].payloadKeys).toEqual(['fullName', 'role']);
    });

    it('extracts TanStack Query useMutation endpoints', () => {
      const code = `
        const mutation = useMutation({
          mutationFn: (newCadet) => axios.post('/api/v1/cadets', newCadet),
          onMutate: () => console.log('optimistic'),
        });
      `;

      const boundaries = extractBoundaryContracts(code, 'react');
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].boundaryType).toBe('tanstack-query');
      expect(boundaries[0].method).toBe('POST');
      expect(boundaries[0].targetEndpoint).toBe('/api/v1/cadets');
      expect(boundaries[0].optimisticUpdate).toBe(true);
    });

    it('extracts Next.js Server Actions ("use server")', () => {
      const code = `
        async function createCadetAction(formData) {
          'use server';
          // backend action
        }
      `;

      const boundaries = extractBoundaryContracts(code, 'react');
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].boundaryType).toBe('server-action');
      expect(boundaries[0].targetEndpoint).toBe('createCadetAction');
      expect(boundaries[0].endpointSource).toBe('action-symbol');
    });
  });

  describe('Pillar 2: Universal Form & Payload Contract', () => {
    it('extracts HTML/Vue template inputs with required status and multipart file upload', () => {
      const template = `
        <form @submit.prevent="submit">
          <input type="text" name="email" v-model="form.email" required />
          <input type="password" name="password" v-model="form.password" required />
          <input type="file" name="avatar" />
        </form>
      `;

      const forms = extractFormContracts('', template);
      expect(forms.length).toBe(1);
      expect(forms[0].isMultipart).toBe(true);
      expect(forms[0].fields.length).toBe(3);

      const emailField = forms[0].fields.find((f) => f.key === 'email');
      expect(emailField).toBeDefined();
      expect(emailField?.required).toBe(true);
      expect(emailField?.type).toBe('text');

      const avatarField = forms[0].fields.find((f) => f.key === 'avatar');
      expect(avatarField).toBeDefined();
      expect(avatarField?.type).toBe('file');
      expect(avatarField?.required).toBe(false);
    });

    it('extracts initial fields declared in useForm', () => {
      const script = `
        const form = useForm({
          student_id: '',
          notes: '',
        });
      `;

      const forms = extractFormContracts(script);
      expect(forms.length).toBe(1);
      expect(forms[0].isMultipart).toBe(false);
      const keys = forms[0].fields.map((f) => f.key);
      expect(keys).toContain('student_id');
      expect(keys).toContain('notes');
    });
  });

  describe('Pillar 3: Universal Implicit Context Graph (Provide/Inject & React Context)', () => {
    it('extracts Vue provide and inject symbols accurately', () => {
      const providerCode = `
        <script setup>
        import { provide } from 'vue';
        provide('themeConfig', { dark: true });
        </script>
      `;

      const consumerCode = `
        <script setup>
        import { inject } from 'vue';
        const theme = inject('themeConfig');
        </script>
      `;

      const providerResult = extractComponentContextNodes('src/views/Parent.vue', providerCode);
      expect(providerResult.providers.length).toBe(1);
      expect(providerResult.providers[0].key).toBe('themeConfig');
      expect(providerResult.providers[0].type).toBe('vue-provide');

      const consumerResult = extractComponentContextNodes('src/components/Child.vue', consumerCode);
      expect(consumerResult.consumers.length).toBe(1);
      expect(consumerResult.consumers[0].key).toBe('themeConfig');
      expect(consumerResult.consumers[0].type).toBe('vue-inject');
    });

    it('extracts React Context.Provider and useContext symbols', () => {
      const providerCode = `
        export function App() {
          return (
            <AuthContext.Provider value={user}>
              <Dashboard />
            </AuthContext.Provider>
          );
        }
      `;

      const consumerCode = `
        export function Profile() {
          const auth = useContext(AuthContext);
          return <div>{auth.name}</div>;
        }
      `;

      const providerResult = extractComponentContextNodes('src/App.tsx', providerCode);
      expect(providerResult.providers.length).toBe(1);
      expect(providerResult.providers[0].key).toBe('AuthContext');
      expect(providerResult.providers[0].type).toBe('react-provider');

      const consumerResult = extractComponentContextNodes('src/Profile.tsx', consumerCode);
      expect(consumerResult.consumers.length).toBe(1);
      expect(consumerResult.consumers[0].key).toBe('AuthContext');
      expect(consumerResult.consumers[0].type).toBe('react-use-context');
    });
  });

  describe('Pillar 4: Zero-Bloat Bundle & Island Architecture Awareness', () => {
    it('formats bundle audit results properly when heavy modules are detected', () => {
      const mockResult = {
        workspaceRoot: '/app',
        totalFilesAudited: 12,
        heavyEagerImports: [
          {
            file: 'src/pages/Analytics.vue',
            line: 4,
            module: 'echarts',
            category: 'chart' as const,
            recommendation: 'Gunakan defineAsyncComponent()',
          },
          {
            file: 'src/pages/Landing.astro',
            line: 12,
            module: 'HeroChart',
            category: 'heavy-utility' as const,
            islandDirective: 'client:load',
            recommendation: 'Beralih ke client:visible',
          },
        ],
        totalWarnings: 2,
      };

      expect(mockResult.heavyEagerImports.length).toBe(2);
      expect(mockResult.heavyEagerImports[0].module).toBe('echarts');
      expect(mockResult.heavyEagerImports[1].islandDirective).toBe('client:load');
    });
  });
});
