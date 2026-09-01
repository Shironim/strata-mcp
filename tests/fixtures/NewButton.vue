<template>
  <button class="new-btn" :class="variant"><slot /></button>
</template>

<script setup lang="ts">
defineProps<{ variant?: string }>();
</script>
