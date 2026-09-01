<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'outline';
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    :class="['base-button', variant || 'primary']"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <slot />
  </button>
</template>

<style scoped>
.base-button {
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  border: none;
}
.primary {
  background-color: #2563eb;
  color: white;
}
.secondary {
  background-color: #4b5563;
  color: white;
}
.outline {
  background-color: transparent;
  border: 1px solid #d1d5db;
  color: #111827;
}
</style>
