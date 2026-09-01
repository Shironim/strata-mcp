<script setup lang="ts">
import BaseButton from './BaseButton.vue';
import StatusBadge from './StatusBadge.vue';

export interface Product {
  id: string;
  name: string;
  price: number;
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
}

defineProps<{
  product: Product;
}>();

defineEmits<{
  (e: 'view-details', product: Product): void;
}>();
</script>

<template>
  <div class="product-card">
    <div class="header">
      <h3>{{ product.name }}</h3>
      <StatusBadge :status="product.status" />
    </div>
    <p class="price">${{ product.price.toFixed(2) }}</p>
    <BaseButton variant="primary" @click="$emit('view-details', product)">
      View Details
    </BaseButton>
  </div>
</template>

<style scoped>
.product-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  background: white;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.price {
  font-size: 18px;
  font-weight: 700;
  margin: 12px 0;
}
</style>
