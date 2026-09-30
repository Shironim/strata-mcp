import { describe, expect, it } from 'bun:test';
import { synthesizeBackendTargetHint, extractApiContractsFromCode } from '../src/engine/api-contract';
import {
  extractVueLayoutStructure,
  extractReactLayoutStructure,
  filterLayoutTokens,
  extractLayoutStructure,
} from '../src/engine/layout-extractor';
import { extractComponentContract } from '../src/engine/contract';

describe('Fullstack Vertical Slice Target Hinting', () => {
  it('synthesizes backend target hints for REST endpoints', () => {
    const postCheckout = synthesizeBackendTargetHint('POST', '/api/v1/checkout');
    expect(postCheckout.targetIntent).toBe('POST api/v1/checkout');
    expect(postCheckout.routePattern).toBe('api/v1/checkout');
    expect(postCheckout.suggestedSymbols).toContain('CheckoutController');
    expect(postCheckout.suggestedSymbols).toContain('CheckoutController@checkout');
    expect(postCheckout.suggestedSymbols).toContain('CheckoutAction');

    const getUser = synthesizeBackendTargetHint('GET', '/api/users/:id');
    expect(getUser.targetIntent).toBe('GET api/users/:id');
    expect(getUser.suggestedSymbols).toContain('UserController');
    expect(getUser.suggestedSymbols).toContain('UserController@show');

    const listProducts = synthesizeBackendTargetHint('GET', '/api/products');
    expect(listProducts.suggestedSymbols).toContain('ProductController@index');

    const deleteOrder = synthesizeBackendTargetHint('DELETE', '/api/orders/:orderId');
    expect(deleteOrder.suggestedSymbols).toContain('OrderController@destroy');

    const updateCategory = synthesizeBackendTargetHint('PUT', '/api/categories/:id');
    expect(updateCategory.suggestedSymbols).toContain('CategoryController@update');
  });

  it('synthesizes backend target hints for Ziggy named routes', () => {
    const ziggyHint = synthesizeBackendTargetHint('POST', "route('orders.store')");
    expect(ziggyHint.namedRoute).toBe('orders.store');
    expect(ziggyHint.targetIntent).toBe('POST orders.store');
    expect(ziggyHint.suggestedSymbols).toContain('OrderController');
    expect(ziggyHint.suggestedSymbols).toContain('OrderController@store');
  });

  it('attaches backendTargetHint during extractApiContractsFromCode', () => {
    const code = `
      import axios from 'axios';
      export async function checkout(payload) {
        return axios.post('/api/v1/checkout', payload);
      }
      export function fetchUser(id) {
        return fetch('/api/users/' + id);
      }
      export function useProfile() {
        return useSWR('/api/profile', fetcher);
      }
      export function submitOrder(data) {
        router.post(route('orders.submit'), data);
      }
    `;

    const items = extractApiContractsFromCode(code, 'src/api.ts');
    expect(items.length).toBe(4);

    const axiosItem = items.find((i) => i.clientKind === 'axios');
    expect(axiosItem).toBeDefined();
    expect(axiosItem?.backendTargetHint?.targetIntent).toBe('POST api/v1/checkout');
    expect(axiosItem?.backendTargetHint?.suggestedSymbols).toContain('CheckoutController');

    const fetchItem = items.find((i) => i.clientKind === 'fetch');
    expect(fetchItem).toBeDefined();
    expect(fetchItem?.backendTargetHint?.suggestedSymbols).toContain('UserController');

    const swrItem = items.find((i) => i.endpoint === '/api/profile');
    expect(swrItem).toBeDefined();
    expect(swrItem?.backendTargetHint?.suggestedSymbols).toContain('ProfileController');

    const inertiaItem = items.find((i) => i.endpoint === "route('orders.submit')");
    expect(inertiaItem).toBeDefined();
    expect(inertiaItem?.method).toBe('POST');
    expect(inertiaItem?.backendTargetHint?.namedRoute).toBe('orders.submit');
  });
});

describe('Multi-Framework Layout & Dynamic Style Extractor', () => {
  it('filters layout-relevant Tailwind tokens', () => {
    const rawClasses = 'flex flex-col min-h-screen text-slate-800 bg-white p-4 max-w-7xl md:grid md:grid-cols-2 relative shadow-lg font-bold';
    const tokens = filterLayoutTokens(rawClasses);

    expect(tokens).toContain('flex');
    expect(tokens).toContain('flex-col');
    expect(tokens).toContain('min-h-screen');
    expect(tokens).toContain('p-4');
    expect(tokens).toContain('max-w-7xl');
    expect(tokens).toContain('md:grid');
    expect(tokens).toContain('md:grid-cols-2');
    expect(tokens).toContain('relative');

    // Decorative classes should be filtered out
    expect(tokens).not.toContain('text-slate-800');
    expect(tokens).not.toContain('bg-white');
    expect(tokens).not.toContain('font-bold');
  });

  it('extracts layout structure and dynamic class bindings from Vue template', () => {
    const template = `
      <div class="flex flex-col min-h-screen relative p-6">
        <header class="w-full h-16 sticky top-0 z-50">
          <button :class="{ 'hidden': !isOpen, 'opacity-50 pointer-events-none': isLoading }">
            Toggle
          </button>
        </header>
        <main class="grid grid-cols-3 gap-4" v-show="isMainVisible">
          <dialog :class="isModalOpen ? 'block fixed inset-0 z-40' : 'hidden'">
            Modal Content
          </dialog>
          <div v-if="hasError" class="p-4 bg-red-100">
            Error
          </div>
        </main>
      </div>
    `;

    const result = extractVueLayoutStructure(template, 0);

    // Root wrapper
    expect(result.rootWrapper).toBeDefined();
    expect(result.rootWrapper?.tag).toBe('div');
    expect(result.rootWrapper?.layoutTokens).toContain('flex');
    expect(result.rootWrapper?.layoutTokens).toContain('flex-col');
    expect(result.rootWrapper?.layoutTokens).toContain('min-h-screen');
    expect(result.rootWrapper?.layoutTokens).toContain('relative');

    // Dynamic bindings
    expect(result.dynamicBindings.length).toBeGreaterThanOrEqual(2);
    const hiddenBinding = result.dynamicBindings.find((b) => b.condition === '!isOpen');
    expect(hiddenBinding).toBeDefined();
    expect(hiddenBinding?.tokens).toContain('hidden');

    const loadingBinding = result.dynamicBindings.find((b) => b.condition === 'isLoading');
    expect(loadingBinding).toBeDefined();

    const ternaryTrue = result.dynamicBindings.find((b) => b.condition === 'isModalOpen');
    expect(ternaryTrue).toBeDefined();
    expect(ternaryTrue?.tokens).toContain('block');

    // Visibility directives
    expect(result.visibilityDirectives.length).toBe(2);
    expect(result.visibilityDirectives.some((v) => v.directive === 'v-show' && v.expression === 'isMainVisible')).toBe(true);
    expect(result.visibilityDirectives.some((v) => v.directive === 'v-if' && v.expression === 'hasError')).toBe(true);
  });

  it('extracts layout structure from React JSX code', () => {
    const reactCode = `
      import React from 'react';
      import { cn } from '@/lib/utils';

      export function Dashboard({ isOpen, hasNotification }) {
        return (
          <main className="grid grid-cols-4 gap-6 max-w-7xl relative">
            <div className={cn('base', isOpen ? 'flex' : 'hidden')}>
              Sidebar
            </div>
            {hasNotification && <aside className="p-4">Notification</aside>}
          </main>
        );
      }
    `;

    const result = extractReactLayoutStructure(reactCode);

    expect(result.rootWrapper).toBeDefined();
    expect(result.rootWrapper?.tag).toBe('main');
    expect(result.rootWrapper?.layoutTokens).toContain('grid');
    expect(result.rootWrapper?.layoutTokens).toContain('grid-cols-4');
    expect(result.rootWrapper?.layoutTokens).toContain('max-w-7xl');

    expect(result.dynamicBindings.length).toBeGreaterThanOrEqual(1);
    expect(result.visibilityDirectives.some((v) => v.expression === 'hasNotification')).toBe(true);
  });

  it('integrates layoutStructure into extractComponentContract', async () => {
    const sfcCode = `
      <template>
        <section class="flex flex-col min-h-screen">
          <div :class="{ 'hidden': isCollapsed }">Content</div>
        </section>
      </template>
      <script setup lang="ts">
      defineProps<{ isCollapsed?: boolean }>();
      </script>
    `;

    const contract = await extractComponentContract('src/TestComponent.vue', sfcCode);
    expect(contract.layoutStructure).toBeDefined();
    expect(contract.layoutStructure?.rootWrapper?.tag).toBe('section');
    expect(contract.layoutStructure?.rootWrapper?.layoutTokens).toContain('flex');
    expect(contract.layoutStructure?.dynamicBindings.length).toBe(1);
    expect(contract.layoutStructure?.dynamicBindings[0].condition).toBe('isCollapsed');
  });
});
