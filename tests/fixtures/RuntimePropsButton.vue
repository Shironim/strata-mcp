<template>
  <button class="runtime-btn"><slot /></button>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  count: { type: Number, default: 0 },
  variant: { type: String, default: 'primary' },
});
</script>
