<script setup lang="ts">
import BaseButton from './BaseButton.vue';
import type { Product } from './ProductCard.vue';

defineProps<{
  product: Product | null;
  isOpen: boolean;
}>();

defineEmits<{
  (e: 'close'): void;
}>();
</script>

<template>
  <div v-if="isOpen && product" class="modal-backdrop">
    <div class="modal-content">
      <h2>{{ product.name }}</h2>
      <p>Product ID: {{ product.id }}</p>
      <p>Price: ${{ product.price.toFixed(2) }}</p>
      <p>Status: {{ product.status }}</p>
      <div class="actions">
        <BaseButton variant="secondary" @click="$emit('close')">
          Close
        </BaseButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-content {
  background: white;
  padding: 24px;
  border-radius: 8px;
  width: 400px;
  max-width: 90%;
}
.actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}
</style>
