<template>
  <div class="async-page">
    <OldButton />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue';

const OldButton = defineAsyncComponent(() => import('./OldButton.vue'));
</script>
