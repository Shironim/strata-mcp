<script setup lang="ts">
defineProps<{
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
}>();
</script>

<template>
  <span :class="['status-badge', status]">
    {{ status.replace('-', ' ').toUpperCase() }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 9999px;
  font-weight: 600;
}
.in-stock {
  background-color: #dcfce7;
  color: #15803d;
}
.low-stock {
  background-color: #fef9c3;
  color: #a16207;
}
.out-of-stock {
  background-color: #fee2e2;
  color: #b91c1c;
}
</style>
