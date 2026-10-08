<template>
  <div class="modal-card">
    <slot name="header" />
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  show?: boolean;
}>();
</script>
