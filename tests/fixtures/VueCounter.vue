<template>
  <div class="vue-counter">
    <span>Count: {{ count }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
