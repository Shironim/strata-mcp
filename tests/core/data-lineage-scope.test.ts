import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractComponentContract,
  extractDataDependencies,
  formatContractAsText,
} from '../../src/engine/contract';
import { getComponentTree, formatTreeAsText } from '../../src/engine/tree';

const INERTIA_APP_DIR = join(import.meta.dir, '../mock-projects/inertia-app');

describe('Data-Fetching Lineage & Monorepo Domain Scope Filtering (Tahap 2)', () => {
  describe('extractDataDependencies', () => {
    it('extracts Next.js Server Actions from inline declarations and imports', () => {
      const code = `
import { updateProfile, deleteAccountAction } from '../actions/user';

export default function ProfilePage() {
  async function inlineAction(formData: FormData) {
    'use server';
    // perform server mutation
  }

  return <form action={inlineAction}><button formAction={deleteAccountAction}>Delete</button></form>;
}
      `;

      const result = extractDataDependencies(code, 'react');
      expect(result).toBeDefined();
      expect(result?.serverActions).toContain('inlineAction');
      expect(result?.serverActions).toContain('updateProfile');
      expect(result?.serverActions).toContain('deleteAccountAction');
    });

    it('extracts TanStack Query keys and SWR keys', () => {
      const code = `
import { useQuery } from '@tanstack/react-query';
import useSWR from 'swr';

export function CartWidget({ userId }: { userId: string }) {
  const { data: cart } = useQuery({
    queryKey: ['cart', userId],
    queryFn: () => fetch('/api/cart/' + userId),
  });

  const { data: user } = useSWR('/api/user/me');
  return <div>{cart?.total}</div>;
}
      `;

      const result = extractDataDependencies(code, 'react');
      expect(result).toBeDefined();
      expect(result?.queryKeys).toContain("['cart', userId]");
      expect(result?.queryKeys).toContain('"/api/user/me"');
      expect(result?.endpoints).toContain('/api/cart/');
      expect(result?.endpoints).toContain('/api/user/me');
    });

    it('extracts Nuxt useAsyncData and $fetch endpoints', () => {
      const code = `
<script setup lang="ts">
const { data: products } = await useAsyncData('products-list', () => $fetch('/api/products'));
const handleSave = async () => {
  await $fetch('/api/products/create', { method: 'POST' });
};
</script>
      `;

      const result = extractDataDependencies(code, 'vue');
      expect(result).toBeDefined();
      expect(result?.queryKeys).toContain('"products-list"');
      expect(result?.endpoints).toContain('/api/products');
      expect(result?.endpoints).toContain('/api/products/create');
    });

    it('extracts Inertia.js form and router mutations', () => {
      const code = `
<script setup>
import { useForm, router } from '@inertiajs/vue3';

const form = useForm({ email: '' });
const submit = () => {
  form.post('/auth/login');
};

const handleLogout = () => {
  router.post('/auth/logout');
};
</script>
      `;

      const result = extractDataDependencies(code, 'vue');
      expect(result).toBeDefined();
      expect(result?.mutations).toContain('POST /auth/login');
      expect(result?.mutations).toContain('POST /auth/logout');
      expect(result?.endpoints).toContain('/auth/login');
      expect(result?.endpoints).toContain('/auth/logout');
    });
  });

  describe('Formatted Text Output with Data Lineage', () => {
    it('formats Data Lineage cleanly in formatContractAsText', async () => {
      const contract = await extractComponentContract(
        'app/cart/page.tsx',
        `
import { checkoutAction } from '@/actions/checkout';
import { useQuery } from '@tanstack/react-query';

export default function CartPage() {
  const { data } = useQuery({ queryKey: ['cart', 'items'] });
  return <button onClick={() => checkoutAction()}>Checkout</button>;
}
        `
      );

      const text = formatContractAsText(contract);
      expect(text).toContain('Data Lineage & Fetching:');
      expect(text).toContain('Server Actions: checkoutAction');
      expect(text).toContain("Query Keys: ['cart', 'items']");
    });
  });

  describe('Monorepo / Package Boundary Scoping (scopeFilter)', () => {
    it('applies scopeFilter to mark and stop traversal at external domain boundaries', async () => {
      const result = await getComponentTree({
        entryPath: join(INERTIA_APP_DIR, 'resources/js/Pages/Dashboard.vue'),
        scopeFilter: 'Pages',
        maxDepth: 3,
      });

      expect(result.root).toBeDefined();
      const text = formatTreeAsText(result);
      expect(text).toContain('Dashboard.vue');
    });
  });
});
