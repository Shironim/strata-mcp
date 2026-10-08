<template>
  <div class="consumer">
    <ModalCard v-model:show="isModalActive">
      <template #header>
        <h3>Custom Header</h3>
      </template>
      <p>Modal content</p>
    </ModalCard>
  </div>
</template>

<script setup lang="ts">
import ModalCard from './ModalCard.vue';
import { ref } from 'vue';

const isModalActive = ref(true);
</script>
