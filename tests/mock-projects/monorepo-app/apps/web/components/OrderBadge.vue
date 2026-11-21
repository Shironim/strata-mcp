<script setup lang="ts">
import type { OrderStatus } from '@acme/shared';

defineProps<{
  status: OrderStatus;
}>();
</script>

<template>
  <span :data-status="status">{{ status }}</span>
</template>
