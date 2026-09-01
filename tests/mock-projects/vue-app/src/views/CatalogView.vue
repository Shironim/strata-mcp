<script setup lang="ts">
import { ref, defineAsyncComponent } from 'vue';
import ProductCard, { type Product } from '../components/ProductCard.vue';
import { BaseButton as ActionButton } from '../components';

// Dynamic lazy import pattern
const ProductModal = defineAsyncComponent(() => import('../components/ProductModal.vue'));

const products = ref<Product[]>([
  { id: '1', name: 'Wireless Headphones', price: 99.99, status: 'in-stock' },
  { id: '2', name: 'Mechanical Keyboard', price: 149.5, status: 'low-stock' },
  { id: '3', name: 'Gaming Mouse', price: 59.0, status: 'out-of-stock' },
]);

const selectedProduct = ref<Product | null>(null);
const isModalOpen = ref(false);

function handleViewDetails(product: Product) {
  selectedProduct.value = product;
  isModalOpen.value = true;
}

function handleRefresh() {
  console.log('Refreshing catalog');
}
</script>

<template>
  <div class="catalog-view">
    <header class="catalog-header">
      <h1>Product Catalog (Vue 3)</h1>
      <!-- Kebab-case and aliased component usage -->
      <action-button variant="outline" @click="handleRefresh">
        Refresh Catalog
      </action-button>
    </header>

    <div class="product-grid">
      <!-- PascalCase component usage -->
      <ProductCard
        v-for="item in products"
        :key="item.id"
        :product="item"
        @view-details="handleViewDetails"
      />
    </div>

    <!-- Dynamic component tag usage -->
    <footer class="catalog-footer">
      <component :is="'BaseButton'" variant="secondary">
        Load More Products
      </component>
    </footer>

    <!-- Lazy loaded modal component -->
    <ProductModal
      :is-open="isModalOpen"
      :product="selectedProduct"
      @close="isModalOpen = false"
    />
  </div>
</template>

<style scoped>
.catalog-view {
  padding: 24px;
  max-width: 1000px;
  margin: 0 auto;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
}
.catalog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}
.catalog-footer {
  margin-top: 32px;
  text-align: center;
}
</style>
