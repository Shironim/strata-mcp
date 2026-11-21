<script setup lang="ts">
import { formatOrderTotal, type OrderDTO } from '@acme/shared';
import BaseButton from './BaseButton.vue';

export type OrderSummaryProps = Omit<OrderDTO, 'internalNote'> & {
  compact?: boolean;
};

const props = defineProps<OrderSummaryProps>();

const emit = defineEmits<{
  (e: 'cancel', orderId: string): void;
}>();
</script>

<template>
  <article>
    <h3>{{ props.customerName }}</h3>
    <p>{{ formatOrderTotal(props.totalCents) }}</p>
    <BaseButton
      label="Cancel Order"
      variant="danger"
      @action="emit('cancel', props.id)"
    />
  </article>
</template>
