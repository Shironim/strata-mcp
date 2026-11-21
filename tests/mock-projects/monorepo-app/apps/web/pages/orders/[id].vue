<script setup lang="ts">
import { BaseButton, OrderSummaryCard } from '@acme/ui';

const orderStore = useOrderStore();
const { cancelOrder } = useOrderApi();

const extraButtonAttrs = {
  disabled: false,
  variant: 'secondary' as const,
};

async function onCancel(orderId: string) {
  await cancelOrder(orderId);
  orderStore.markCancelled();
}
</script>

<template>
  <main v-if="orderStore.state.activeOrder">
    <OrderBadge :status="orderStore.state.activeOrder.status" />
    <OrderSummaryCard
      :id="orderStore.state.activeOrder.id"
      :customer-name="orderStore.state.activeOrder.customerName"
      :total-cents="orderStore.state.activeOrder.totalCents"
      :status="orderStore.state.activeOrder.status"
      @cancel="onCancel"
    />
    <BaseButton label="Refresh" v-bind="extraButtonAttrs" />
  </main>
</template>
