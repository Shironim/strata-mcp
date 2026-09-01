<template>
  <button @click="emit('add-laptop')">Add</button>
  <span>{{ formatPrice(total) }}</span>
</template>

<script setup>
const emit = defineEmits(['add-laptop']);
const total = 0;
function formatPrice(v) {
  return v;
}
</script>
